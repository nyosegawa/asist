/**
 * Freezes the memory block of the system prompt. Changing the block invalidates the prompt cache from
 * that point on, so the block is rebuilt only when at least the freeze interval has passed since the
 * previous turn, and stays frozen while the cache is alive. Memories written in the meantime are
 * reached through recall instead. Only a deletion made by the user takes effect immediately, through
 * invalidate, so that deleted content is not kept in the prompt.
 */

export const MEMORY_BLOCK_FREEZE_MS = 5 * 60_000

export class FrozenMemoryBlock {
  private block: string | null = null
  private built = false
  private lastTurnAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly build: () => string | null,
    private readonly freezeMs = MEMORY_BLOCK_FREEZE_MS
  ) {}

  /** Called at the start of a turn. While the block is frozen it returns the one built earlier. */
  forTurn(now: number): string | null {
    if (!this.built || now - this.lastTurnAt >= this.freezeMs) {
      this.block = this.build()
      this.built = true
    }
    this.lastTurnAt = now
    return this.block
  }

  /** Makes the next turn rebuild the block. */
  invalidate(): void {
    this.built = false
  }
}
