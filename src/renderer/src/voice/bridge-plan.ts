import type { BridgePlan } from '@shared/ipc'

/**
 * Looks ahead while the user is still speaking: every updated partial transcript goes to a fast
 * model, and the newest result feeds the aizuchi classification and the bridging phrase once speech
 * ends. Only one request is in flight at a time: while one runs the newest input is held back and
 * sent once it returns, and results from a superseded capture are dropped.
 */

/** A partial transcript shorter than this carries nothing to plan on. */
const MIN_PLAN_CHARS = 4
/** Once speech has ended, even a short partial transcript is sent once, since the bridging phrase is built from it. */
const MIN_FINISH_CHARS = 2

export interface PlanInput {
  text: string
  lastAssistantText: string
}

export interface PlannerPorts {
  plan(input: PlanInput): Promise<BridgePlan>
  /** Called whenever a plan comes back; the HUD displays it. */
  onPlan(plan: BridgePlan, input: PlanInput): void
  onFailure(error: unknown): void
}

export class BridgePlanner {
  private latest: BridgePlan | null = null
  private inflight = false
  private pending: PlanInput | null = null
  private lastText = ''
  private generation = 0
  /** Callers of finish that are waiting for the request in flight to return. */
  private waiters: Array<(plan: BridgePlan | null) => void> = []

  constructor(private readonly ports: PlannerPorts) {}

  /** Called when capture starts. It discards the previous utterance's plan and any request still in flight. */
  reset(): void {
    this.generation++
    this.latest = null
    this.pending = null
    this.lastText = ''
    this.settle(null)
  }

  /** Takes an updated partial transcript. Text identical to the last one is not sent again. */
  observe(input: PlanInput): void {
    const text = input.text.trim()
    if (text.length < MIN_PLAN_CHARS || text === this.lastText) return
    this.lastText = text
    if (this.inflight) {
      this.pending = { ...input, text }
      return
    }
    void this.run({ ...input, text })
  }

  /** The latest plan, or null. The aizuchi is decided from this, because it cannot wait for a newer one. */
  current(): BridgePlan | null {
    return this.latest
  }

  /**
   * Marks the end of speech. If nothing has been sent yet it sends the last partial transcript, and
   * if a request is in flight it waits for it. Waiting is allowed here because the bridging phrase
   * only has to play before the answer itself.
   */
  finish(input: PlanInput): Promise<BridgePlan | null> {
    const text = input.text.trim()
    if (!this.inflight && this.latest === null && text.length >= MIN_FINISH_CHARS && text !== this.lastText) {
      this.lastText = text
      void this.run({ ...input, text })
    }
    if (!this.inflight) return Promise.resolve(this.latest)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private settle(plan: BridgePlan | null): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve(plan)
  }

  private async run(input: PlanInput): Promise<void> {
    const generation = this.generation
    this.inflight = true
    try {
      const plan = await this.ports.plan(input)
      if (generation === this.generation) {
        this.latest = plan
        this.ports.onPlan(plan, input)
      }
    } catch (error) {
      if (generation === this.generation) this.ports.onFailure(error)
    } finally {
      this.inflight = false
      const next = this.pending
      this.pending = null
      if (next && generation === this.generation) void this.run(next)
      if (!this.inflight) this.settle(generation === this.generation ? this.latest : null)
    }
  }
}
