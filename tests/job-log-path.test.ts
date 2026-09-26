import { describe, expect, it } from 'vitest'
import { shortPath } from '../src/renderer/src/ui/JobLog'

describe('shortPath', () => {
  it('keeps the last two names of a long path in the separator it is written with', () => {
    expect(shortPath('/Users/me/repo/src/app.ts')).toBe('…/src/app.ts')
    expect(shortPath('C:\\Users\\me\\repo\\src\\app.ts')).toBe('…\\src\\app.ts')
    expect(shortPath('C:/Users/me/repo/src/app.ts')).toBe('…/src/app.ts')
  })

  it('leaves a path of two names or fewer whole', () => {
    for (const p of ['/Users/me', 'C:\\Users\\me', 'src/app.ts', 'app.ts', '/']) expect(shortPath(p)).toBe(p)
  })
})
