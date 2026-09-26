/**
 * Runs conversation turns strictly one at a time and aborts the running turn when a new one arrives.
 * A turn that is waiting for the user's answer holds the abort off until it lets go. Every turn runs,
 * in the order it started: one that a newer turn replaced while it waited runs with its signal already
 * aborted and closes at once, so that what the user said in it is still recorded.
 */

export interface TurnRunContext {
  turnId: number
  signal: AbortSignal
  /**
   * Keeps the turn from being aborted until the returned release is called. An abort asked for
   * meanwhile, by abort() or by a newer turn, takes effect at the release, and the newer turn still
   * waits for this one to end.
   */
  hold: () => () => void
}

export interface TurnHandle {
  turnId: number
  signal: AbortSignal
  completion: Promise<void>
}

interface ScheduledTurn {
  turnId: number
  controller: AbortController
  holds: number
  abortAtRelease: boolean
}

export class LatestTurnScheduler {
  private nextTurnId = 1
  private current: ScheduledTurn | null = null
  private tail: Promise<void> = Promise.resolve()

  start(run: (ctx: TurnRunContext) => Promise<void>): TurnHandle {
    if (this.current) this.stop(this.current)

    const turn: ScheduledTurn = { turnId: this.nextTurnId++, controller: new AbortController(), holds: 0, abortAtRelease: false }
    const { turnId, controller } = turn
    const previous = this.tail.catch(() => {})
    const completion = previous
      .then(() => run({ turnId, signal: controller.signal, hold: () => this.hold(turn) }))
      .finally(() => {
        if (this.current?.turnId === turnId) this.current = null
      })

    this.current = turn
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
    if (this.current?.turnId === turnId) this.stop(this.current)
  }

  private stop(turn: ScheduledTurn): void {
    if (turn.holds > 0) turn.abortAtRelease = true
    else turn.controller.abort()
  }

  private hold(turn: ScheduledTurn): () => void {
    turn.holds++
    let released = false
    return () => {
      if (released) return
      released = true
      turn.holds--
      if (turn.holds === 0 && turn.abortAtRelease) turn.controller.abort()
    }
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
