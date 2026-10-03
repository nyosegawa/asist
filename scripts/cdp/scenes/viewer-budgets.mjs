#!/usr/bin/env node
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, launchChrome, previewPath, sleep, waitForApp } from '../cdp.mjs'
import { SERVED_FILES_PATH, startDemo } from '../demo-server.mjs'
import { measureFile } from '../viewer-measure.mjs'
import { prepareFiles, VIEWER_FILES } from '../viewer-files/index.mjs'

/**
 * The scene that measures the viewers of the files card on large files (npm run demo:viewer-budgets). It writes
 * large files of each kind into a folder (viewer-files/), serves them from the demo, and measures each case's file
 * in the card and its focus view, one Chrome at a time (viewer-measure.mjs). A case fails when a measured value is
 * past its limit, when its viewer shows an error, a placard or a note that leaves the content out, when a screen of
 * the focus view is never shown, or when a frame crashes; the run then exits with code 2. A case's budget, the
 * tighter numbers its viewer meets on a developer's Mac, is reported and never fails the run: it is for comparing
 * a change to a viewer with what the viewer did before. The memory is read with ps, so the scene stops with an
 * error on Windows.
 *
 * The limits catch a viewer that went back to reading or drawing the whole file, and stay clear of how far the
 * same code moves on a shared runner. In 91 runs on GitHub's macOS runner on 2026-10-02 and 03, of main and of the
 * pull requests then open, the viewers showed their content within 2.0 s (1.2 s at the 99th percentile), held the
 * main thread for at most 781 ms (270 ms at the 99th percentile), took at most 820 ms for a screen, and grew the
 * renderers by at most 699 MB at the peak and 416 MB at the end, and the GPU process by 217 MB; the workbooks by
 * 437 MB at the peak and the zip by 55 MB. Two runs of one commit gave 781 and 64 ms for xlsx-50k's focus view, and
 * +494 and +374 MB for the deck's peak. Before the viewers were made light, on an M5 with the limits on file sizes
 * lifted, the Word report showed after 24 s and grew the page by 2.5 GB, the deck after 8.5 s and by 1.9 GB, the
 * two-hour MP3 after 15.6 s and by 9.6 GB, the one-hour WAV after 4.6 s and by 10.5 GB, the 200-page PDF grew it by
 * 5.1 GB and the GPU process by 1.4 GB, and the workbooks by 0.54 and 0.90 GB, which the runner's 1.7 to 1.9 times
 * the M5's memory for the same viewer makes 0.9 to 1.7 GB there.
 *
 * The cases live one file per viewer in viewer-budgets/, each exporting `cases`, so that a change to one viewer
 * adds or edits only its own file:
 *
 *   export const cases = [{
 *     name: 'pdf-1000',            // unique among all cases
 *     file: 'pdf-1000',            // a key of VIEWER_FILES
 *     budget: { cardFirstMs, cardHeldMs, completeMs, cardPeakMb, focusFirstMs, focusHeldMs, slowestScreenMs,
 *               peakMb, finalMb, gpuPeakMb }, // any of them, reported
 *     limit: { peakMb },           // optional: limits of its own in place of LIMITS', where a regression is smaller
 *     shown: (root, mode) => …,    // optional: when the content in view is drawn
 *     complete: (root) => …        // optional: when the card has finished, such as a whole waveform
 *   }]
 *
 * `shown` and `complete` are sent to the page as their source and run there at every frame with the card's or
 * the focus view's element, so they use nothing from outside their own body. Without `shown`, viewer-measure.mjs's
 * contentShown decides, which never takes a placard or a note for content.
 *
 * Usage: npm run demo:viewer-budgets -- [--case name]... [--measure file|all]... [--files folder] [--time-factor n] [--out folder]
 *   --case          runs only the cases named
 *   --measure       measures files of VIEWER_FILES with no budget or limit, for numbers to set a budget from
 *   --files         keeps the generated files in this folder and reuses them on the next run; without it they
 *                   are written to a temporary folder and removed at the end
 *   --time-factor   multiplies every time budget, for a slower machine (CI passes 3); memory budgets stay as written
 *   --out           also writes the results as viewer-budgets.json there
 */

const args = process.argv.slice(2)
const values = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []))
const single = (name) => values(name).at(-1)
const timeFactor = Number(single('time-factor') ?? 1)
if (!(timeFactor >= 1)) throw new Error(`--time-factor は 1 以上の数です: ${single('time-factor')}`)

/** What each key of a budget or a limit reads from a result, and whether --time-factor scales it. */
const BUDGETS = {
  cardFirstMs: { read: (r) => r.card.firstMs, time: true },
  cardHeldMs: { read: (r) => r.card.heldMs, time: true },
  completeMs: { read: (r) => r.card.completeMs, time: true },
  cardPeakMb: { read: (r) => r.memory.cardPeakMb, time: false },
  focusFirstMs: { read: (r) => r.focus.firstMs, time: true },
  focusHeldMs: { read: (r) => r.focus.heldMs, time: true },
  slowestScreenMs: { read: (r) => r.focus.slowestScreenMs, time: true },
  peakMb: { read: (r) => r.memory.peakMb, time: false },
  finalMb: { read: (r) => r.memory.finalMb, time: false },
  gpuPeakMb: { read: (r) => r.memory.gpuPeakMb, time: false }
}

/**
 * What fails a case: content first shown after 5 s, against 2.0 s at most now and 4.6 to 24 s before for the
 * report, the deck and the recordings; the main thread held for 2 s, against 0.78 s at most now (the old viewers
 * held it for 0.13 to 0.81 s on the M5, and their time or memory catches them); a screen after 3 s, against 0.82 s;
 * the renderers grown by 1.5 GB at the peak, against 0.70 GB now and 1.9 to 10.5 GB before, and by 1 GB at the end,
 * against 0.42 GB now and up to 4.2 GB before; and the GPU process by 1 GB, against 0.22 GB now and 1.4 GB before.
 * A case lowers a limit where going back costs less, as the workbooks and the zip do. The time to complete a
 * waveform has no limit: a waveform that never completes fails when its wait runs out.
 */
const LIMITS = { cardFirstMs: 5000, focusFirstMs: 5000, cardHeldMs: 2000, focusHeldMs: 2000, slowestScreenMs: 3000, peakMb: 1500, finalMb: 1000, gpuPeakMb: 1000 }

/** Every case of every file in viewer-budgets/, checked for what a typo would otherwise turn into a silent pass. */
async function loadCases() {
  const folder = new URL('./viewer-budgets/', import.meta.url)
  const files = readdirSync(folder).filter((name) => name.endsWith('.mjs')).sort()
  const cases = []
  for (const file of files) {
    const module = await import(new URL(file, folder).href)
    if (!Array.isArray(module.cases)) throw new Error(`viewer-budgets/${file} が cases を export していません`)
    for (const one of module.cases) {
      const where = `viewer-budgets/${file} の ${one.name}`
      if (!one.name || cases.some((other) => other.name === one.name)) throw new Error(`${where}: name がないか、ほかの case と同じです`)
      if (!VIEWER_FILES[one.file]) throw new Error(`${where}: file は ${Object.keys(VIEWER_FILES).join(', ')} のどれかです: ${one.file}`)
      const unknown = Object.keys(one.budget ?? {}).filter((key) => !BUDGETS[key])
      if (unknown.length || Object.keys(one.budget ?? {}).length === 0) throw new Error(`${where}: budget には ${Object.keys(BUDGETS).join(', ')} を書きます`)
      if (one.budget.completeMs !== undefined && !one.complete) throw new Error(`${where}: completeMs を測るには complete が要ります`)
      const unknownLimits = Object.keys(one.limit ?? {}).filter((key) => !BUDGETS[key])
      if (unknownLimits.length) throw new Error(`${where}: limit には ${Object.keys(BUDGETS).join(', ')} を書きます`)
      cases.push(one)
    }
  }
  return cases
}

const allCases = await loadCases()
const measured = values('measure')
const named = values('case')
const unknownCases = named.filter((name) => !allCases.some((one) => one.name === name))
if (unknownCases.length) throw new Error(`そういう case はありません: ${unknownCases.join(', ')}`)
const unknownFiles = measured.filter((name) => name !== 'all' && !VIEWER_FILES[name])
if (unknownFiles.length) throw new Error(`--measure は all か ${Object.keys(VIEWER_FILES).join(', ')} です: ${unknownFiles.join(', ')}`)
const runs = measured.length
  ? (measured.includes('all') ? Object.keys(VIEWER_FILES) : measured).map((file) => ({ name: file, file, budget: null, limit: null }))
  : allCases.filter((one) => named.length === 0 || named.includes(one.name))
if (runs.length === 0) {
  console.log('viewer budgets  no case to run (viewer-budgets/ holds none)')
  process.exit()
}

const log = (line) => console.error(line)
const kept = single('files')
const root = kept ? path.resolve(kept) : mkdtempSync(path.join(os.tmpdir(), 'asist-viewer-files-'))
const results = []
let demo = null
try {
  const { folder, files } = await prepareFiles([...new Set(runs.map((run) => run.file))], root, log)
  demo = await startDemo({ files: folder })
  // The first page compiles the viewers' modules in Vite, which would otherwise count against the first case.
  {
    const chrome = await launchChrome()
    const client = await connect(chrome.port)
    await client.navigate(new URL(`${previewPath('/cards')}?type=files`, demo.origin).href)
    await waitForApp(client)
    await sleep(3000)
    client.close()
    await chrome.close()
  }
  for (const run of runs) {
    const { file, bytes } = files[run.file]
    log(`measuring ${run.name} (${file}, ${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    const entry = { name: run.name, file, bytes, budget: run.budget }
    try {
      entry.result = await measureFile({
        origin: demo.origin,
        path: path.join(folder, file),
        url: `${SERVED_FILES_PATH}${encodeURIComponent(file)}`,
        sizeBytes: bytes,
        scrolls: VIEWER_FILES[run.file].scrolls !== false,
        ...(run.shown ? { shown: run.shown } : {}),
        ...(run.complete ? { complete: run.complete } : {})
      })
      // A value that is not a number is past any budget or limit, rather than slipping past a comparison.
      const beyond = (bounds, factor) =>
        Object.entries(bounds)
          .map(([key, bound]) => ({ key, bound: BUDGETS[key].time ? bound * factor : bound, value: BUDGETS[key].read(entry.result) }))
          .filter(({ bound, value }) => !(value <= bound))
      entry.over = run.budget ? beyond(run.budget, timeFactor) : []
      entry.past = run.limit === null ? [] : beyond({ ...LIMITS, ...run.limit }, 1)
    } catch (error) {
      entry.error = error.message
    }
    results.push(entry)
  }
} finally {
  await demo?.close()
  if (!kept) rmSync(root, { recursive: true, force: true })
}

const ms = (value) => (value === undefined ? '' : `${value.toLocaleString('en-US')} ms`)
const mb = (value) => `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US')} MB`
const columns = [
  ['case', (e) => e.name],
  ['file', (e) => `${e.file} (${(e.bytes / 1024 / 1024).toFixed(0)} MB)`],
  ['card first', (e) => ms(e.result?.card.firstMs)],
  ['complete', (e) => ms(e.result?.card.completeMs)],
  ['card held', (e) => ms(e.result?.card.heldMs)],
  ['card peak', (e) => (e.result ? mb(e.result.memory.cardPeakMb) : '')],
  ['focus first', (e) => ms(e.result?.focus.firstMs)],
  ['focus held', (e) => ms(e.result?.focus.heldMs)],
  ['screens', (e) => (e.result ? String(e.result.focus.screens) : '')],
  ['slowest screen', (e) => ms(e.result?.focus.slowestScreenMs)],
  ['peak', (e) => (e.result ? mb(e.result.memory.peakMb) : '')],
  ['final', (e) => (e.result ? mb(e.result.memory.finalMb) : '')],
  ['GPU peak', (e) => (e.result ? mb(e.result.memory.gpuPeakMb) : '')]
]
const rows = results.map((entry) => columns.map(([, cell]) => cell(entry)))
const widths = columns.map(([title], i) => Math.max(title.length, ...rows.map((row) => row[i].length)))
const line = (cells) => cells.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')
const failed = results.filter((entry) => entry.error || entry.past.length > 0)
const alone = results.length === 1
const heading = `${results.length} ${measured.length ? `${alone ? 'file' : 'files'} measured without a budget` : `${alone ? 'case' : 'cases'}${timeFactor === 1 ? '' : `, times in the budgets ×${timeFactor}`}`}`
const amount = (value) => value?.toLocaleString('en-US')
const failures = failed.flatMap((entry) => [
  `${entry.name}: ${entry.error ? `failed: ${entry.error}` : 'past its limit'}`,
  ...(entry.past ?? []).map(({ key, bound, value }) => `  ${key} ${amount(value)} is past ${amount(bound)}`)
])
const overs = results
  .filter((entry) => entry.over?.length)
  .flatMap((entry) => [`${entry.name}: over its budget, which fails nothing`, ...entry.over.map(({ key, bound, value }) => `  ${key} ${amount(value)} is over ${amount(bound)}`)])
const notes = [...(overs.length ? ['', ...overs] : []), ...(failures.length ? ['', ...failures] : [])]
console.log([`viewer budgets  ${heading}`, line(columns.map(([title]) => title)), ...rows.map(line), ...notes].join('\n'))

const out = single('out')
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'viewer-budgets.json'), JSON.stringify({ timeFactor, results }, null, 2))
}
// On GitHub the table also goes to the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (text) => String(text).replace(/\|/g, '\\|')
  const summary = ['### demo:viewer-budgets', '', heading, '', `| ${columns.map(([title]) => title).join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`]
  for (const row of rows) summary.push(`| ${row.map(cell).join(' | ')} |`)
  if (notes.length) summary.push('', '```', ...notes.slice(1), '```')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)
}
if (failed.length > 0) process.exitCode = 2
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
