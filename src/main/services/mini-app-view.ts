import { openMiniAppSchema, type MiniAppView } from '@shared/mini-apps'

/**
 * The mini app the renderer last reported as open. The renderer owns this state and reports every
 * change, so main only keeps the latest report and never persists it: after a restart nothing is open
 * until the renderer says otherwise.
 */

let current: MiniAppView | null = null

export function reportOpenMiniApp(report: unknown): void {
  current = openMiniAppSchema.parse(report)
}

export function openMiniApp(): MiniAppView | null {
  return current
}
