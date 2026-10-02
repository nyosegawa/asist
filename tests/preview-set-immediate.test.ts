import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The setImmediate the preview page gives the JSZip inside mammoth, which waits with a clamped setTimeout(0)
 * between two steps of its work where it finds none. Node has its own, so each test takes it away and loads the
 * module again.
 */

type SetImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => void

async function installed(): Promise<SetImmediate> {
  vi.stubGlobal('setImmediate', undefined)
  vi.resetModules()
  await import('@/preview/set-immediate')
  return (globalThis as unknown as { setImmediate: SetImmediate }).setImmediate
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("the preview page's setImmediate", () => {
  it('runs each callback once, with its arguments and in the order they were given, without a timeout', async () => {
    const setImmediate = await installed()
    const timeout = vi.fn()
    vi.stubGlobal('setTimeout', timeout)
    const calls: unknown[][] = []
    await new Promise<void>((resolve) => {
      for (let i = 0; i < 100; i++) setImmediate((...args) => calls.push(args), i, `step ${i}`)
      setImmediate(() => resolve())
    })
    expect(calls).toEqual(Array.from({ length: 100 }, (_, i) => [i, `step ${i}`]))
    expect(timeout).not.toHaveBeenCalled()
  })

  it('runs a callback as a task of its own, after the microtasks queued with it, so that the page gets its turn between two', async () => {
    const setImmediate = await installed()
    const ran: string[] = []
    setImmediate(() => ran.push('immediate'))
    queueMicrotask(() => ran.push('microtask'))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(ran).toEqual(['microtask'])
    for (let i = 0; i < 10 && ran.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toEqual(['microtask', 'immediate'])
  })
})
