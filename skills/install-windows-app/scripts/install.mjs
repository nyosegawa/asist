#!/usr/bin/env node
import { execFileSync, execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Installs the Windows build of ASIST for the current user, launches it with logging, and quits it.
 *
 *   node skills/install-windows-app/scripts/install.mjs [--build] [--replace-running] [--launch [--cdp]]
 *   node skills/install-windows-app/scripts/install.mjs --quit
 *
 *   --build            run npm run dist:win first (without it, the installer already in dist\)
 *   --replace-running  stop a running ASIST and replace it (without it, stop when one is running)
 *   --launch           after installing, start the app with --enable-logging and print where the log is
 *   --cdp              with --launch, also open the DevTools protocol on port 9222
 *   --quit             stop the running ASIST and do nothing else
 *
 * ASIST_LOG sets where the launch log goes.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const installed = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'asist', 'ASIST.exe')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function running() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ASIST.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return out.includes('"ASIST.exe"')
}

// Closing the window only hides it, and the tray's quit is a menu no script can reach, so the app is
// stopped by force. The agent launcher's job object stops any agent CLI with it.
function stop() {
  if (!running()) return
  execFileSync('taskkill', ['/IM', 'ASIST.exe', '/F', '/T'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 10_000
  while (running()) {
    if (Date.now() > deadline) fail('ASIST.exe が 10 秒たっても終わりません')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
}

const args = new Set(process.argv.slice(2))
const known = ['--build', '--replace-running', '--launch', '--cdp', '--quit']
for (const arg of args) if (!known.includes(arg)) fail(`不明な引数: ${arg}`)
if (process.platform !== 'win32') fail('このスクリプトは Windows で動かします。Mac では install-mac-app を使います')
if (args.has('--cdp') && !args.has('--launch')) fail('--cdp は --launch と一緒に指定します')

if (args.has('--quit')) {
  stop()
  console.log('ASIST を終了しました')
  process.exit(0)
}

if (args.has('--build')) execSync('npm run dist:win', { cwd: repo, stdio: 'inherit', windowsHide: true })
const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const installer = path.join(repo, 'dist', `ASIST Setup ${version}.exe`)
if (!fs.existsSync(installer)) fail(`インストーラーがありません: ${installer}(--build を付けてください)`)

if (running()) {
  if (!args.has('--replace-running')) fail('ASIST が動いています。--replace-running を付けるか、終了してから実行してください')
  stop()
}

// /S installs without a window into %LOCALAPPDATA%\Programs\asist and, unlike a double-click, does not
// start the app afterwards.
execFileSync(installer, ['/S'], { stdio: 'inherit', windowsHide: true })
if (!fs.existsSync(installed)) fail(`インストールのあとに ${installed} がありません`)
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
console.log(`installed ${installed} from ${commit} at ${new Date().toLocaleString('sv-SE').slice(0, 16)}`)

if (args.has('--launch')) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const log = process.env.ASIST_LOG ?? path.join(os.tmpdir(), `asist-${stamp}.log`)
  const out = fs.openSync(log, 'a')
  const appArgs = ['--enable-logging', ...(args.has('--cdp') ? ['--remote-debugging-port=9222'] : [])]
  // windowsHide would pass SW_HIDE to the app, and Windows applies it to the first window the app shows.
  spawn(installed, appArgs, { detached: true, stdio: ['ignore', out, out], windowsHide: false }).unref()
  console.log(`launched with logging: ${log}${args.has('--cdp') ? ' (CDP: http://127.0.0.1:9222/json)' : ''}`)
}
