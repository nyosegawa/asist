import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Puts speech.cpp's `speech` into resources/speech, pinned to one release and verified by sha256. The local
 * speech synthesis runs in its worker, `speech worker MODEL`: Metal on a Mac, Vulkan on Windows. The executable
 * links the library and ggml statically, so it is one file, and the shared library and the header the archive
 * also holds are left out.
 */

export const VERSION = '0.7.0'
const MODULE = fileURLToPath(import.meta.url)

const ASSETS = {
  'darwin-arm64': {
    name: 'speech-0.7.0-macos-arm64-metal.zip',
    sha256: '82512c301e9fe1647ca46abdd969d799b9381b6cbb33330e780740c49ca2d5ed',
    program: 'speech'
  },
  'win32-x64': {
    name: 'speech-0.7.0-windows-x64-vulkan.zip',
    sha256: '4ed4e7f2107381b7185fd365cad2c5433db959c888b314737f8f6dfa7c342ac5',
    program: 'speech.exe'
  }
}

export async function prepareSpeech({ resources, platform, arch }) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`speech.cpp ${VERSION} is not pinned for ${platform} ${arch}`)
  // Releases before 0.7.0 were prepared into resources/speech-worker, which Git no longer ignores, so a checkout
  // that prepared one would otherwise show it as new files to commit.
  fs.rmSync(path.join(resources, 'speech-worker'), { recursive: true, force: true })
  const out = path.join(resources, 'speech')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-speech-', async (work) => {
    const base = 'https://github.com/nyosegawa/speech.cpp'
    const archive = path.join(work, asset.name)
    console.error(`speech.cpp: fetching ${VERSION}`)
    await download(`${base}/releases/download/v${VERSION}/${asset.name}`, archive, asset.sha256)
    extract(archive, path.join(work, 'unpacked'))
    await download(`${base}/raw/v${VERSION}/LICENSE`, path.join(work, 'LICENSE'))
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    fs.copyFileSync(path.join(work, 'unpacked', asset.program), path.join(out, asset.program))
    fs.chmodSync(path.join(out, asset.program), 0o755)
    fs.copyFileSync(path.join(work, 'LICENSE'), path.join(out, 'LICENSE'))
    writeStamp(stamp, VERSION, MODULE)
  })
}
