import { openMiniAppSchema, type MiniAppView } from '@shared/mini-apps'

/**
 * The mini app the renderer last reported as open. The renderer owns this state and reports every
 * change, so main only keeps the latest report and never persists it: after a restart nothing is open
 * until the renderer says otherwise.
 */

let current: MiniAppView | null = null
const waiting = new Set<(view: MiniAppView | null) => void>()

export function reportOpenMiniApp(report: unknown): void {
  current = openMiniAppSchema.parse(report)
  for (const answer of waiting) answer(current)
  waiting.clear()
}

export function openMiniApp(): MiniAppView | null {
  return current
}

/**
 * The next report of the renderer. After a request to open or close a mini app it tells what the request
 * left on screen, since the renderer reports once it has made the change or the user has turned it down.
 */
export function nextOpenMiniApp(signal: AbortSignal): Promise<MiniAppView | null> {
  return new Promise((resolve, reject) => {
    const answer = (view: MiniAppView | null): void => {
      signal.removeEventListener('abort', abort)
      resolve(view)
    }
    const abort = (): void => {
      waiting.delete(answer)
      reject(signal.reason)
    }
    if (signal.aborted) return abort()
    waiting.add(answer)
    signal.addEventListener('abort', abort, { once: true })
  })
}
