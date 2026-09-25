import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/unused', on: vi.fn() } }))

import { uvEnv } from '../src/main/services/uv'

describe('the environment uv runs with', () => {
  it('drops the user uv settings that would change the Python or the package index, and keeps its files under userData', () => {
    const env = uvEnv(
      { PATH: '/usr/bin', UV_INDEX_URL: 'https://mirror.invalid/simple', UV_PYTHON_PREFERENCE: 'only-system', UV_PYTHON_DOWNLOADS: 'never' },
      '/data'
    )
    expect(env.UV_INDEX_URL).toBeUndefined()
    expect(env.UV_PYTHON_PREFERENCE).toBeUndefined()
    expect(env.UV_PYTHON_DOWNLOADS).toBeUndefined()
    expect(env.UV_NO_CONFIG).toBe('1')
    expect(env.UV_PYTHON_INSTALL_DIR).toBe('/data/python')
    expect(env.UV_CACHE_DIR).toBe('/data/uv-cache')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('passes no provider key to uv', () => {
    expect(uvEnv({ ANTHROPIC_API_KEY: 'sk-test' }, '/data').ANTHROPIC_API_KEY).toBeUndefined()
  })
})
