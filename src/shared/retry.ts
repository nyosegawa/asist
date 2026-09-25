/**
 * A general retry loop, used by brain to retry API streaming with a model fallback. Sleeping is
 * injectable so that tests run without waiting.
 */

export interface RetryContext {
  /** The attempt number, counted from zero. */
  attempt: number
  isLast: boolean
}

export interface RetryOptions {
  /** The waits between attempts. The number of attempts is delays.length + 1. */
  delays: number[]
  /**
   * Whether this error may be retried. It returns false when a retry would be harmful rather than
   * merely useless, such as after the reply has already been spoken and would be spoken twice.
   */
  shouldRetry: (err: unknown, ctx: RetryContext) => boolean
  onRetry?: (err: unknown, ctx: RetryContext) => void
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function withRetry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    const ctx: RetryContext = { attempt, isLast: attempt >= options.delays.length }
    try {
      return await fn(ctx)
    } catch (err) {
      if (ctx.isLast || !options.shouldRetry(err, ctx)) throw err
      options.onRetry?.(err, ctx)
      await sleep(options.delays[attempt])
    }
  }
}
