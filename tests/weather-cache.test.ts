import { describe, expect, it, vi } from 'vitest'
import { WeatherCache } from '../src/main/services/weather/cache'

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
const signal = () => new AbortController().signal
const decode = (text: string) => JSON.parse(text)

describe('weather cache', () => {
  it('shares a concurrent fetch and fetches again once the entry expires', async () => {
    let now = 0
    const request = vi.fn().mockImplementation(async () => new Response('{"value":1}'))
    const cache = new WeatherCache(request, () => now)
    expect(
      await Promise.all([
        cache.read('a', 100, signal(), decode),
        cache.read('a', 100, signal(), decode)
      ])
    ).toEqual([{ value: 1 }, { value: 1 }])
    await cache.read('a', 100, signal(), decode)
    expect(request).toHaveBeenCalledOnce()
    now = 100
    await cache.read('a', 100, signal(), decode)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('keeps the fetch running for the other waiters when one of them aborts', async () => {
    let finish!: (response: Response) => void
    let underlying!: AbortSignal
    const request = vi.fn().mockImplementation((_url, options) => {
      underlying = options.signal
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    })
    const cache = new WeatherCache(request)
    const controller = new AbortController()
    const first = cache.read('a', 100, controller.signal, decode)
    const rejected = expect(first).rejects.toThrow()
    const second = cache.read('a', 100, signal(), decode)
    controller.abort()
    expect(underlying.aborted).toBe(false)
    finish(new Response('{"value":2}'))
    await rejected
    expect(await second).toEqual({ value: 2 })
    expect(request).toHaveBeenCalledOnce()
  })
  it('does not reuse a fetch that every waiter abandoned for a new request', async () => {
    let oldSignal!: AbortSignal
    const request = vi
      .fn()
      .mockImplementationOnce((_url, options) => {
        oldSignal = options.signal
        return new Promise((_resolve, reject) =>
          oldSignal.addEventListener('abort', () => reject(oldSignal.reason))
        )
      })
      .mockResolvedValueOnce(new Response('{}'))
    const cache = new WeatherCache(request)
    const controller = new AbortController()
    const first = cache.read('a', 100, controller.signal, decode)
    const rejected = expect(first).rejects.toThrow()
    controller.abort()
    await rejected
    expect(oldSignal.aborted).toBe(true)
    expect(await cache.read('a', 100, signal(), decode)).toEqual({})
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('caches neither an HTTP failure nor malformed data', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('bad'))
      .mockResolvedValueOnce(new Response('{}'))
    const cache = new WeatherCache(request)
    await expect(cache.read('a', 100, signal(), decode)).rejects.toThrow('503')
    await expect(cache.read('a', 100, signal(), decode)).rejects.toThrow()
    expect(await cache.read('a', 100, signal(), decode)).toEqual({})
    expect(request).toHaveBeenCalledTimes(3)
  })
})
