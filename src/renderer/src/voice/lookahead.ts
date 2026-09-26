/**
 * Runs the partial transcripts of the capture in progress through an asynchronous model and keeps
 * the newest result for the moment speech ends. Within a capture one request is in flight at a time:
 * while it runs the newest input waits and goes out once it returns, and a text identical to the
 * last one sent is not sent again. Each capture has its own queue, so a request left over from the
 * previous capture neither holds back nor swallows the input of the next one, and its result is
 * dropped.
 */

interface Capture<I, R> {
  latest: R | null
  lastText: string
  inflight: boolean
  pending: I | null
  /** Called once the capture has nothing in flight or waiting, or once a newer capture begins. */
  waiters: Array<() => void>
}

export interface LookaheadPorts<I, R> {
  request(input: I): Promise<R>
  /** Folds a result into the latest one of the capture. */
  fold(latest: R | null, result: R): R
  /** Called whenever the latest result of the current capture changes; the HUD displays it. */
  onResult(latest: R, input: I): void
  onFailure(error: unknown): void
}

const newCapture = <I, R>(): Capture<I, R> => ({
  latest: null,
  lastText: '',
  inflight: false,
  pending: null,
  waiters: []
})

export class PartialLookahead<I extends { text: string }, R> {
  private capture: Capture<I, R> = newCapture()

  constructor(private readonly ports: LookaheadPorts<I, R>) {}

  /** Called when capture starts. It leaves the previous capture's result and requests behind. */
  reset(): void {
    const previous = this.capture
    this.capture = newCapture()
    this.settle(previous)
  }

  /** Sends the input, or holds it while a request of this capture is in flight. */
  send(input: I): void {
    const capture = this.capture
    if (input.text === capture.lastText) return
    capture.lastText = input.text
    if (capture.inflight) {
      capture.pending = input
      return
    }
    void this.run(capture, input)
  }

  /** The latest result of the current capture, or null. */
  current(): R | null {
    return this.capture.latest
  }

  /** Whether a request of the current capture is in flight. */
  get busy(): boolean {
    return this.capture.inflight
  }

  /** Waits until the current capture has nothing in flight or waiting, and returns its latest result, or null once a newer capture has begun. */
  settled(): Promise<R | null> {
    const capture = this.capture
    if (!capture.inflight) return Promise.resolve(capture.latest)
    return new Promise((resolve) =>
      capture.waiters.push(() => resolve(capture === this.capture ? capture.latest : null))
    )
  }

  private settle(capture: Capture<I, R>): void {
    const waiters = capture.waiters
    capture.waiters = []
    for (const resolve of waiters) resolve()
  }

  private async run(capture: Capture<I, R>, input: I): Promise<void> {
    capture.inflight = true
    try {
      const result = await this.ports.request(input)
      if (capture === this.capture) {
        capture.latest = this.ports.fold(capture.latest, result)
        this.ports.onResult(capture.latest, input)
      }
    } catch (error) {
      if (capture === this.capture) this.ports.onFailure(error)
    } finally {
      capture.inflight = false
      const next = capture.pending
      capture.pending = null
      if (next && capture === this.capture) void this.run(capture, next)
      else this.settle(capture)
    }
  }
}
