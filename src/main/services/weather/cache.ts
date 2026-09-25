import { errorText } from '@shared/i18n/error-text'
import { userAgent } from '../user-agent'

interface Pending {
  controller: AbortController
  promise: Promise<unknown>
  users: number
}
export class WeatherCache {
  private values = new Map<string, { expires: number; value: unknown }>()
  private pending = new Map<string, Pending>()

  constructor(
    private request: typeof fetch = fetch,
    private now: () => number = Date.now
  ) {}

  read<T>(url: string, ttl: number, signal: AbortSignal, decode: (text: string) => T): Promise<T> {
    signal.throwIfAborted()
    const cached = this.values.get(url)
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.value as T)
    this.values.delete(url)
    let work = this.pending.get(url)
    if (!work) {
      const controller = new AbortController()
      const created: Pending = { controller, users: 0, promise: Promise.resolve() }
      work = created
      this.pending.set(url, created)
      created.promise = (async () => {
        const response = await this.request(url, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
          headers: { 'user-agent': userAgent() }
        })
        if (!response.ok) throw new Error(errorText('cardsWeather.errors.fetchFailed', { status: response.status }))
        const value = decode(await response.text())
        controller.signal.throwIfAborted()
        this.values.set(url, { expires: this.now() + ttl, value })
        for (const [key, entry] of this.values)
          if (entry.expires <= this.now()) this.values.delete(key)
        return value
      })().finally(() => {
        if (this.pending.get(url) === created) this.pending.delete(url)
      })
    }
    const pending = work
    pending.users++
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const release = (): boolean => {
        if (finished) return false
        finished = true
        signal.removeEventListener('abort', abort)
        pending.users--
        if (pending.users === 0 && this.pending.get(url) === pending) {
          this.pending.delete(url)
          pending.controller.abort()
        }
        return true
      }
      const abort = (): void => {
        if (release()) reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      pending.promise.then(
        (value) => {
          if (release()) resolve(value as T)
        },
        (error) => {
          if (release()) reject(error)
        }
      )
      if (signal.aborted) abort()
    })
  }
}
