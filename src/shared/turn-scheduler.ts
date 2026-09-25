/**
 * Runs conversation turns strictly one at a time and aborts the running turn when a new one arrives.
 */

export interface TurnRunContext {
  turnId: number
  signal: AbortSignal
}

export interface TurnHandle {
  turnId: number
  signal: AbortSignal
  completion: Promise<void>
}

export class LatestTurnScheduler {
  private nextTurnId = 1
  private current: { turnId: number; controller: AbortController } | null = null
  private tail: Promise<void> = Promise.resolve()

  start(run: (ctx: TurnRunContext) => Promise<void>): TurnHandle {
    this.current?.controller.abort()

    const turnId = this.nextTurnId++
    const controller = new AbortController()
    const previous = this.tail.catch(() => {})
    const completion = previous
      .then(async () => {
        // While this turn waited for the previous one, a newer turn replaced it.
        if (controller.signal.aborted) return
        await run({ turnId, signal: controller.signal })
      })
      .finally(() => {
        if (this.current?.turnId === turnId) this.current = null
      })

    this.current = { turnId, controller }
    // A failed turn must not block the turns behind it.
    this.tail = completion.catch(() => {})
    return { turnId, signal: controller.signal, completion }
  }

  /** For system interjections. It never takes over a user turn, and returns null instead. */
  startIfIdle(run: (ctx: TurnRunContext) => Promise<void>): TurnHandle | null {
    if (this.current !== null) return null
    return this.start(run)
  }

  abort(turnId: number): void {
    if (this.current?.turnId === turnId) this.current.controller.abort()
  }

  get activeTurnId(): number | null {
    return this.current?.turnId ?? null
  }

  /**
   * Takes a turnId without running a turn, for the live engines, whose exchanges come from the model
   * itself rather than through brain but still go into the conversation log and the events. It draws
   * from the same counter as start, so the ids never collide.
   */
  allocateTurnId(): number {
    return this.nextTurnId++
  }

  async waitForIdle(): Promise<void> {
    await this.tail
  }
}
