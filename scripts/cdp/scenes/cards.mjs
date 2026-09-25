#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../drive.mjs'

/**
 * The scene that opens a weather card on each side and captures it at the l, m and s window heights to
 * check that it fits (npm run demo:cards).
 *
 * Usage: npm run demo:cards -- [output directory] [--say text]... [--sizes l,m,s]
 *   Without an output directory it writes to a temporary one, and without --say it uses two weather
 *   utterances.
 * Output: card-l.png, card-m.png and card-s.png, plus card-sizes.json with the measurements per size.
 *
 * A new scene starts as a copy of this file with different steps, plus a demo:<name> entry in
 * package.json.
 */

const DEFAULT_SAYINGS = ['長野県の今日の天気を教えて', '東京都の明日の天気を教えて']
const argv = process.argv.slice(2)
const out = argv.find((a) => !a.startsWith('--')) ?? (await mkdtemp(path.join(os.tmpdir(), 'asist-cards-')))
const sayings = argv.flatMap((a, i) => (a === '--say' ? [argv[i + 1]] : []))
const sizesIndex = argv.indexOf('--sizes')
const sizes = (sizesIndex >= 0 ? argv[sizesIndex + 1] : 'l,m,s').split(',')

const steps = [
  ...(sayings.length ? sayings : DEFAULT_SAYINGS).map((value) => ({ op: 'say', value })),
  ...sizes.flatMap((size) => [
    { op: 'size', value: size },
    { op: 'cards' },
    { op: 'shot', value: size }
  ])
]
const report = await main(steps, { launch: true, out, name: 'card' })
const bySize = Object.fromEntries(report.steps.filter((s) => s.op === 'cards').map((s) => [s.size, s.result]))
await writeFile(path.join(out, 'card-sizes.json'), JSON.stringify(bySize, null, 2))
console.log(`written: ${out}`)
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
