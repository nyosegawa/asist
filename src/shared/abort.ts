/** Applies the caller's cancellation and the operation's own timeout at the same time. */
export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Releases only this caller's wait on abort; the shared operation keeps running. A failure that
 * arrives afterwards is consumed, so it never surfaces as an unhandled rejection.
 */
export function waitWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    void Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
