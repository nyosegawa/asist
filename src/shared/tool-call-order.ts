/**
 * The order in which tool calls start, like a read-write lock over the calls in the order they arrive.
 * A call the registry marks parallel waits for the writing calls before it, and a writing call waits
 * for every call before it, so that two writes, and two approvals, never run at once. A call keeps its
 * place until its work has ended (`completion`), not until it answers: a tool that timed out has
 * answered but may still be working.
 */
export class ToolCallOrder {
  private readonly unfinished = new Set<Promise<void>>()
  private lastWrite: Promise<void> = Promise.resolve()

  /**
   * Runs `start` once the calls this one waits for have ended. `start` returns the call's work, or null
   * for a call that is no longer to run, which gives up its place at once. The work comes back wrapped,
   * because a promise resolved with a task would take the task's result and lose its `completion`.
   */
  run<Work extends { readonly completion: Promise<unknown> }>(parallel: boolean, start: () => Work | null): Promise<{ work: Work } | null> {
    const turn = parallel ? this.lastWrite : Promise.all([...this.unfinished]).then(() => undefined)
    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    this.unfinished.add(finished)
    void finished.then(() => this.unfinished.delete(finished))
    if (!parallel) this.lastWrite = finished
    return turn.then(() => {
      let work: Work | null
      try {
        work = start()
      } catch (err) {
        finish()
        throw err
      }
      if (!work) {
        finish()
        return null
      }
      void work.completion.then(finish, finish)
      return { work }
    })
  }
}
