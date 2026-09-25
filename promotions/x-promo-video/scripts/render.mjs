import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, launchChrome, sleep } from '../../../scripts/cdp/cdp.mjs'

/**
 * Renders index.html frame by frame in headless Chrome by seeking its GSAP timeline, and writes the
 * sound cues the timeline declares for audio.py.
 *   node scripts/render.mjs            out/frames/*.jpg and out/cues.json
 *   node scripts/render.mjs 3.5 14.5   out/stills/t3.5.jpg and t14.5.jpg, to check single moments
 */

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, 'out')
const FPS = 30
const stills = process.argv.slice(2).map(Number)

const { port } = await launchChrome()
const page = await connect(port)
await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
await page.navigate(pathToFileURL(resolve(ROOT, 'index.html')).href)
// The page defines __ready once its script has run; it resolves when the fonts and images are decoded.
while (!(await page.evaluate('typeof window.__ready === "object"'))) await sleep(100)
await page.evaluate('window.__ready.then(() => true)')
if (page.exceptions().length) throw new Error(page.exceptions().map((e) => e.text).join('\n'))

mkdirSync(OUT, { recursive: true })
const duration = await page.evaluate('window.__duration')
writeFileSync(resolve(OUT, 'cues.json'), JSON.stringify({ duration, fps: FPS, cues: await page.evaluate('window.__cues') }, null, 1))

const shoot = async (t, file) => {
  // The seek's return value is the timeline itself, which cannot be serialized back.
  await page.evaluate(`__seek(${t}); 0`)
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

if (stills.length) {
  mkdirSync(resolve(OUT, 'stills'), { recursive: true })
  for (const t of stills) await shoot(t, resolve(OUT, `stills/t${t}.jpg`))
} else {
  const dir = resolve(OUT, 'frames')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const total = Math.round(duration * FPS)
  for (let f = 0; f < total; f++) {
    await shoot(f / FPS, `${dir}/f${String(f).padStart(5, '0')}.jpg`)
    if (f % 300 === 0) console.log(`frame ${f}/${total}`)
  }
}
page.close()
process.exit(0)
