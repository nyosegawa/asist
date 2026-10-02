import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { APP_PATH, connect, connectBrowser, launchChrome, sleep, waitForApp, WINDOWS } from './cdp.mjs'

/**
 * Measures one file in the files card and its focus view, in a Chrome of its own on the demo's app at window
 * size l (1440 x 828 at 2x, which makes the focus view 760 x 680), as a person opens it: the card appears, the
 * person opens the focus view, scrolls it a screen at a time to the end and closes it again.
 *
 * - first: the milliseconds until the content in view is drawn, from showing the card or from pressing the
 *   card's expand button. By default that is when the viewer no longer says it is loading and every canvas and
 *   picture in view has been drawn; a case can say what it means for its viewer instead (`shown`).
 * - held: the longest time the page's main thread did not get to run, measured by a timer that asks to run
 *   every TICK_MS. It covers showing the card and the SETTLE_MS after, and separately the focus view from its
 *   opening to the end of the scroll.
 * - memory: what the renderer processes of the page hold (RSS), sampled every SAMPLE_MS: the peak, and the final
 *   once the focus view is closed and garbage is collected, both over what the app held before the card appeared.
 *   They include any iframe a viewer runs in a process of its own. The GPU process's peak is reported beside it.
 */

/** The screens the focus view is scrolled through before it is scrolled to the end, as the survey of 2026-10-02 did. */
const SCREENS = 120
/** How long each screen stays in view: a person paging quickly through a long document. */
const STEP_MS = 150
/** How long the page is left to finish what it started after something is shown, before it is measured. */
const SETTLE_MS = 1000
const SAMPLE_MS = 100
const TICK_MS = 5
/** How long a viewer has to show its content before the case fails, whatever its budget. */
const SHOW_TIMEOUT_MS = 120_000

/**
 * Flags that keep this Chrome from starting renderers of its own while a file is measured, for extensions,
 * components and a spare, of 100 to 130 MB each (measured 2026-10-02). One that starts during a measurement could
 * not be told from an iframe of the page's, and without these flags the renderers grew by 200 MB while a card
 * that reads nothing was shown.
 */
const QUIET = [
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-features=SpareRendererForSitePerProcess'
]

const CARD = '.panel-card[data-panel-type="files"]'
const FOCUS = '.panel-focus[data-panel-type="files"]'

/**
 * Whether the content in view is drawn, evaluated in the page with the root of the card or of the focus view.
 * It stands for any viewer that a case does not describe itself, so it reads only what every viewer shares: the
 * frame, the loading note, and the canvases and pictures inside the part of the frame that can be seen. A canvas
 * counts as drawn once it holds more than one colour, shrunk to 16 x 16, which a page that is only cleared to
 * white does not.
 */
function contentShown(root) {
  const frame = root.querySelector('.fv-frame')
  if (!frame) return false
  const loading = window.demoText('files.viewer.loading')
  if ([...frame.querySelectorAll('.fv-note')].some((note) => note.textContent.trim() === loading)) return false
  const box = (el) => el.getBoundingClientRect()
  const clips = [box(root), box(frame.querySelector('.fv-scroll') ?? frame), { top: 0, left: 0, bottom: innerHeight, right: innerWidth }]
  const inView = (el) => {
    const r = box(el)
    if (r.width === 0 || r.height === 0) return false
    const top = Math.max(r.top, ...clips.map((c) => c.top))
    const bottom = Math.min(r.bottom, ...clips.map((c) => c.bottom))
    const left = Math.max(r.left, ...clips.map((c) => c.left))
    const right = Math.min(r.right, ...clips.map((c) => c.right))
    return bottom > top && right > left
  }
  for (const img of frame.querySelectorAll('img')) if (inView(img) && !(img.complete && img.naturalWidth > 0)) return false
  const sample = (window.__budgetSample ??= new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true }))
  // Shrunk with the default smoothing, a canvas is read at a few of its pixels only, which missed the 2 px line
  // of a waveform; the high quality averages all of them.
  sample.imageSmoothingQuality = 'high'
  for (const canvas of frame.querySelectorAll('canvas')) {
    if (!inView(canvas)) continue
    if (canvas.width === 0 || canvas.height === 0) return false
    sample.clearRect(0, 0, 16, 16)
    sample.drawImage(canvas, 0, 0, 16, 16)
    const data = sample.getImageData(0, 0, 16, 16).data
    let varied = false
    for (let i = 4; i < data.length && !varied; i += 4) {
      varied = data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]
    }
    if (!varied) return false
  }
  return true
}

const PROBE = `(() => {
  const probe = { held: 0, last: performance.now() }
  setInterval(() => {
    const now = performance.now()
    probe.held = Math.max(probe.held, now - probe.last - ${TICK_MS})
    probe.last = now
  }, ${TICK_MS})
  window.__budgetProbe = probe
  return null
})()`
const resetHeld = `(() => { window.__budgetProbe.held = 0; window.__budgetProbe.last = performance.now(); return null })()`
const readHeld = `Math.round(window.__budgetProbe.held)`

/**
 * An expression that runs `action` and resolves with the milliseconds until `check(root)` holds for the element of
 * `selector`, checked at every frame. A viewer's error note fails it with the note's text.
 */
function timed(action, selector, check, mode, timeoutMs) {
  return `new Promise((resolve, reject) => {
    const check = ${check}
    const started = performance.now()
    ${action}
    const poll = () => {
      const root = document.querySelector(${JSON.stringify(selector)})
      const error = root?.querySelector('.fv-note[data-tone="error"]')
      if (error) return reject(new Error('the viewer showed an error: ' + error.textContent.trim()))
      if (root && check(root, ${JSON.stringify(mode)})) return resolve(Math.round(performance.now() - started))
      if (performance.now() - started > ${timeoutMs}) return reject(new Error('nothing was shown within ${timeoutMs / 1000} s'))
      requestAnimationFrame(poll)
    }
    poll()
  })`
}

const execFileAsync = promisify(execFile)

/**
 * The resident memory of each process, in MB, read with ps. A process that ended after Chrome listed it is
 * missing from the answer, which counts it as holding nothing, as it no longer does; ps then exits with 1 but
 * still prints the others.
 */
async function residentMb(pids) {
  if (pids.length === 0) return new Map()
  if (process.platform === 'win32') throw new Error('メモリは ps で測ります。Windows では測れません')
  const stdout = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { windowsHide: true }).then(
    (result) => result.stdout,
    (error) => {
      if (error.code === 1 && error.stdout !== undefined) return error.stdout
      throw error
    }
  )
  const rows = stdout.trim().split('\n').filter(Boolean)
  return new Map(rows.map((line) => line.trim().split(/\s+/).map(Number)).map(([pid, kb]) => [pid, kb / 1024]))
}

/** The process ids of this Chrome, by type: renderer, GPU and so on. */
async function processes(browser) {
  const { processInfo } = await browser.send('SystemInfo.getProcessInfo')
  return (type) => processInfo.filter((p) => p.type === type).map((p) => p.id)
}

/**
 * The renderers of this Chrome that do not serve the page. Headless Chrome keeps a renderer of its own for the
 * WebUI of the omnibox popup, about 200 MB, which no flag removes and which once gave up 180 MB in the middle of
 * a measurement (2026-10-02). The page's own renderer is the one a trace names for its main frame; every other
 * renderer that exists before the card is shown is left out of the sums, and one that starts later, such as an
 * iframe's, is counted.
 */
async function foreignRenderers(browser, client) {
  const events = []
  let finished
  const complete = new Promise((resolve) => {
    finished = resolve
  })
  const stop = client.onEvent((msg) => {
    if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value)
    if (msg.method === 'Tracing.tracingComplete') finished()
  })
  await client.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' })
  await client.send('Tracing.end')
  await complete
  stop()
  const frames = events.find((event) => event.name === 'TracingStartedInBrowser')?.args.data.frames ?? []
  const page = new Set(frames.map((frame) => frame.processId))
  if (page.size === 0) throw new Error('ページのレンダラーがトレースにありません')
  return new Set((await processes(browser))('renderer').filter((pid) => !page.has(pid)))
}

async function memory(browser, foreign) {
  const ids = await processes(browser)
  const renderers = ids('renderer').filter((pid) => !foreign.has(pid))
  const gpu = ids('GPU')
  const rss = await residentMb([...renderers, ...gpu])
  const total = (list) => list.reduce((sum, pid) => sum + (rss.get(pid) ?? 0), 0)
  return { renderer: total(renderers), gpu: total(gpu) }
}

/** Samples the memory until stopped and keeps the peaks. */
function sampler(browser, foreign) {
  let running = true
  const peak = { renderer: 0, gpu: 0 }
  const done = (async () => {
    while (running) {
      const now = await memory(browser, foreign)
      peak.renderer = Math.max(peak.renderer, now.renderer)
      peak.gpu = Math.max(peak.gpu, now.gpu)
      await sleep(SAMPLE_MS)
    }
  })()
  return {
    peak,
    stop: async () => {
      running = false
      await done
    }
  }
}

/** The median of three samples a little apart, which keeps a passing spike out of a resting value. */
async function resting(browser, foreign) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    samples.push(await memory(browser, foreign))
    await sleep(SAMPLE_MS)
  }
  const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[1]
  return { renderer: median('renderer'), gpu: median('gpu') }
}

/**
 * Measures the file served at `url` and shown as `path`. `shown(root, mode)` and `complete(root)` are functions
 * evaluated in the page, so they use nothing from outside their own body.
 */
export async function measureFile({ origin, path, url, sizeBytes, shown = contentShown, complete = null }) {
  const chrome = await launchChrome({ args: QUIET })
  const browser = await connectBrowser(chrome.port)
  const client = await connect(chrome.port)
  let crashed
  const crash = new Promise((_, reject) => {
    crashed = reject
  })
  crash.catch(() => {})
  client.onEvent((msg) => {
    if (msg.method === 'Inspector.targetCrashed') crashed(new Error('the page crashed'))
  })
  const guard = (promise) => Promise.race([promise, crash])
  let samples = null
  try {
    await client.send('Inspector.enable')
    await client.resize(WINDOWS.l)
    await client.navigate(new URL(APP_PATH, origin).href)
    await waitForApp(client)
    await client.evaluate(PROBE)
    await sleep(SETTLE_MS)
    await client.send('HeapProfiler.collectGarbage')
    const foreign = await foreignRenderers(browser, client)
    const baseline = await resting(browser, foreign)
    samples = sampler(browser, foreign)

    const show = `window.demoShowFile(${JSON.stringify({ path, url, sizeBytes })})`
    await client.evaluate(resetHeld)
    const card = { firstMs: await guard(client.evaluate(timed(show, CARD, shown, 'card', SHOW_TIMEOUT_MS))) }
    if (complete) card.completeMs = card.firstMs + (await guard(client.evaluate(timed('', CARD, complete, 'card', SHOW_TIMEOUT_MS))))
    await sleep(SETTLE_MS)
    card.heldMs = await guard(client.evaluate(readHeld))
    card.widthPx = await client.evaluate(`Math.round(document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect().width)`)

    const expand = `document.querySelector(${JSON.stringify(CARD)} + ' button[aria-label="' + CSS.escape(window.demoText('panels.expand')) + '"]').click()`
    await client.evaluate(resetHeld)
    const focus = { firstMs: await guard(client.evaluate(timed(expand, FOCUS, shown, 'focus', SHOW_TIMEOUT_MS))) }
    const scrolled = await guard(
      client.evaluate(`(async () => {
        const scroller = document.querySelector(${JSON.stringify(FOCUS)})
        let screens = 0
        while (screens < ${SCREENS}) {
          const before = scroller.scrollTop
          scroller.scrollTop += scroller.clientHeight
          if (scroller.scrollTop === before) break
          screens += 1
          await new Promise((resolve) => setTimeout(resolve, ${STEP_MS}))
        }
        scroller.scrollTop = scroller.scrollHeight
        return { screens, heightPx: Math.round(scroller.scrollHeight) }
      })()`)
    )
    await sleep(SETTLE_MS)
    Object.assign(focus, scrolled, { heldMs: await guard(client.evaluate(readHeld)) })

    await client.evaluate(`document.querySelector(${JSON.stringify(FOCUS)} + ' button[aria-label="' + CSS.escape(window.demoText('panels.closeFocus')) + '"]').click()`)
    await sleep(SETTLE_MS)
    await client.send('HeapProfiler.collectGarbage')
    await sleep(SETTLE_MS)
    await samples.stop()
    const final = await resting(browser, foreign)
    const mb = (value) => Math.round(value)
    return {
      card,
      focus,
      memory: {
        baselineMb: mb(baseline.renderer),
        peakMb: mb(samples.peak.renderer - baseline.renderer),
        finalMb: mb(final.renderer - baseline.renderer),
        gpuPeakMb: mb(samples.peak.gpu - baseline.gpu)
      }
    }
  } finally {
    await samples?.stop()
    client.close()
    browser.close()
    await chrome.close()
  }
}
