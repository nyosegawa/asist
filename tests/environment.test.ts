import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const locations = vi.hoisted(() => ({ dir: '', userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => locations.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))

beforeEach(() => {
  vi.resetModules()
  locations.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-environment-'))
  locations.userData = path.join(locations.dir, 'user-data')
  fs.mkdirSync(locations.userData)
  vi.spyOn(process, 'cwd').mockReturnValue(locations.dir)
  for (const name of ['VOICEVOX_URL', 'AIVISSPEECH_URL', 'VOICEVOX_SPEAKER']) {
    vi.stubEnv(name, undefined)
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(locations.dir, { recursive: true, force: true })
})

it('loads the environment before it initializes the endpoints and the new settings, and keeps the precedence', async () => {
  fs.writeFileSync(path.join(locations.dir, '.env'), 'VOICEVOX_URL=http://127.0.0.1:59991\nAIVISSPEECH_URL=http://127.0.0.1:59993\nVOICEVOX_SPEAKER=7\n')
  vi.stubEnv('VOICEVOX_SPEAKER', '3')
  const fetch = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetch)

  await import('../src/main/environment')
  const settings = await import('../src/main/services/settings')
  const tts = await import('../src/main/services/tts')
  // A variable inherited from the parent process wins over the .env in the working directory.
  expect(settings.getSettings()).toMatchObject({ voicevoxSpeaker: 3 })
  await tts.available('voicevox')
  await tts.available('aivisspeech')
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'http://127.0.0.1:59991/version', 'http://127.0.0.1:59993/version'
  ])
})
