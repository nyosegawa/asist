#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { previewPath } from '../cdp.mjs'
import { main } from '../drive.mjs'

/**
 * The scene that captures the card gallery (/preview/cards) as one tall image (npm run demo:gallery).
 *
 * Usage: npm run demo:gallery -- [output directory] [--type kind]... [--theme name]
 *   With --type only those kinds are shown, for instance --type fx --type weather. Without it every
 *   kind is shown and the image grows very tall. --theme draws the cards in that theme (src/shared/themes.ts).
 * Output: gallery.png, or gallery-<kind>.png when the kinds are narrowed, with -<theme> added when a theme is named.
 */

const argv = process.argv.slice(2)
const valueOf = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))
const flagValues = new Set([...valueOf('--type'), ...valueOf('--theme')])
const out = argv.find((a) => !a.startsWith('--') && !flagValues.has(a)) ?? (await mkdtemp(path.join(os.tmpdir(), 'asist-gallery-')))
const types = valueOf('--type')
const [theme] = valueOf('--theme')
const query = new URLSearchParams(types.map((type) => ['type', type]))
if (theme) query.set('theme', theme)
const url = `${previewPath('/cards')}${query.size ? `?${query}` : ''}`
const name = ['gallery', ...types, ...(theme ? [theme] : [])].join('-')

await main(
  [
    { op: 'size', value: '1720x900' },
    { op: 'wait', value: '1500' },
    { op: 'fit', value: '.gallery' },
    { op: 'shot', value: name }
  ],
  { launch: true, url, out }
)
console.log(`written: ${out}`)
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
