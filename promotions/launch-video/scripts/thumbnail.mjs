import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, launchChrome, sleep } from '../../../scripts/cdp/cdp.mjs'

/**
 * Renders thumbnail.html to out/youtube-thumbnail.png at 1280 x 720, the size YouTube asks for.
 * YouTube refuses a thumbnail over 2 MB, so a larger file stops the run.
 */

const ROOT = resolve(import.meta.dirname, '..')
const out = resolve(ROOT, 'out/youtube-thumbnail.png')
const { port } = await launchChrome()
const page = await connect(port)
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await page.navigate(pathToFileURL(resolve(ROOT, 'thumbnail.html')).href)
while ((await page.evaluate('document.readyState')) !== 'complete') await sleep(100)
const loaded = await page.evaluate('document.fonts.ready.then(() => document.fonts.check("900 78px \\"Zen Maru Gothic\\""))')
if (!loaded) throw new Error('Zen Maru Gothic did not load')
const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
const png = Buffer.from(data, 'base64')
if (png.length > 2 * 1024 * 1024) throw new Error(`the thumbnail is ${png.length} bytes, over the 2 MB YouTube accepts`)
mkdirSync(resolve(ROOT, 'out'), { recursive: true })
writeFileSync(out, png)
console.log(`${out} (${(png.length / 1024).toFixed(0)} KB)`)
page.close()
process.exit(0)
