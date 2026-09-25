import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, launchChrome, sleep } from '../../scripts/cdp/cdp.mjs'

/** Writes og.html, the card social sites show for the website, to public/img/og.png at 1200×630. */

const here = import.meta.dirname
const { port } = await launchChrome()
const page = await connect(port)
await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
await page.navigate(pathToFileURL(resolve(here, 'og.html')).href)
while ((await page.evaluate('document.readyState')) !== 'complete') await sleep(100)
// The headings use Google Fonts; a capture before they load falls back to the system's rounded font.
await page.evaluate('document.fonts.ready.then(() => document.fonts.check("900 46px \\"Zen Maru Gothic\\""))').then((loaded) => {
  if (!loaded) throw new Error('Zen Maru Gothic did not load; og.html needs the network for Google Fonts')
})
const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
const out = resolve(here, '../public/img/og.png')
writeFileSync(out, Buffer.from(data, 'base64'))
console.log(out)
process.exit(0)
