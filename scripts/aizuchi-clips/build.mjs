#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { AIZUCHI_BANK } from '../../src/shared/aizuchi-bank.ts'

/**
 * Pre-renders the aizuchi bank for one Qwen3-TTS voice into resources/aizuchi/qwen3tts/<voice>/ and
 * writes a page for listening to the result. curate.py explains why the clips are made ahead of time.
 *
 *   node scripts/aizuchi-clips/build.mjs <voice> <review.html> [candidates] [text ...]
 *
 * With texts given, only those entries of the bank are rendered again and the other clips are kept.
 * Commit the clips only after listening to the review page; every regeneration adds binary history.
 */

const [voice, reviewPath, candidates = '4', ...only] = process.argv.slice(2)
if (!voice || !reviewPath) {
  console.error('usage: node scripts/aizuchi-clips/build.mjs <voice> <review.html> [candidates] [text ...]')
  process.exit(2)
}

const root = path.resolve(import.meta.dirname, '../..')
const python = process.env.ASIST_MLX_PYTHON || path.join(homedir(), 'Library/Application Support/asist/mlx-audio-runtime/bin/python')
const outDir = path.join(root, 'resources/aizuchi/qwen3tts', voice)
const defs = AIZUCHI_BANK.map(({ text, speedScale, volumeScale }) => ({ text, speedScale, volumeScale }))
// Two categories share "あー、はい。" under the same conditions, and one clip serves both.
const unique = defs
  .filter((def, index) => defs.findIndex((other) => JSON.stringify(other) === JSON.stringify(def)) === index)
  .filter((def) => only.length === 0 || only.includes(def.text))
const reportPath = `${reviewPath}.json`

const child = spawn(python, [path.join(import.meta.dirname, 'curate.py'), voice, 'japanese', outDir, candidates, reportPath], { stdio: ['pipe', 'ignore', 'inherit'] })
child.stdin.end(JSON.stringify(unique))
child.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  rmSync(reportPath)
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const rows = report.clips.map((clip, index) => {
    const cells = clip.candidates.map((candidate, rank) => `
      <td class="${rank === 0 ? 'chosen' : ''}">
        <audio controls preload="none" src="data:audio/wav;base64,${candidate.audio}"></audio>
        <div>${candidate.ms} ms, pause ${candidate.pause_ms} ms</div>
        <div class="${clip.exact ? 'ok' : 'warn'}">ASR: ${escape(candidate.heard)}</div>
      </td>`).join('')
    return `<tr><th>${String(index).padStart(2, '0')}<br>${escape(clip.text)}<br><small>${clip.usable ?? 'none'} verified</small></th>${cells || '<td class="warn">no verified candidate</td>'}</tr>`
  }).join('\n')
  writeFileSync(reviewPath, `<!doctype html><meta charset="utf-8"><title>Aizuchi clips: ${escape(voice)}</title>
<style>
  body { font: 14px/1.5 system-ui; margin: 24px; background: #111; color: #ddd }
  table { border-collapse: collapse } th, td { border: 1px solid #333; padding: 8px 12px; vertical-align: top; text-align: left }
  th { font-size: 16px; white-space: nowrap } small { color: #888; font-weight: normal }
  .chosen { background: #16241b } .ok { color: #7c7 } .warn { color: #e96 } audio { height: 32px; width: 240px }
</style>
<h1>Aizuchi clips: ${escape(voice)}</h1>
<p>The first column of each row is the clip that was written to resources; the others are the runners-up. An orange transcript means the recognizer heard only part of the aizuchi, so the ear has to decide.</p>
<table>${rows}</table>
`)
  console.error(`wrote ${outDir} and ${reviewPath}`)
})
