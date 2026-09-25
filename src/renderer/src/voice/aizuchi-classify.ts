import { nextClassification, type AizuchiClassification } from '@shared/aizuchi-classifier'

/**
 * Runs the partial transcripts through the aizuchi classifier, a worker in the main process, and
 * holds the latest classification for the moment speech ends. Only one request is in flight at a
 * time: while one runs the newest input is held back and sent once it returns, and results from a
 * superseded capture are dropped. Switching classification follows the rule in nextClassification,
 * because a classification that flips on every partial transcript makes the aizuchi choice waver.
 *
 * End of speech, as decided by the VAD, does not wait for a request. The worker answers a sentence
 * in about 2 ms, so by then the classification of the last partial transcript or the one before it
 * is available; with none, no aizuchi plays.
 */

/** A partial transcript shorter than this carries nothing to classify on. */
const MIN_CHARS = 2

export interface ClassifyInput {
  prev: string
  text: string
}

export interface ClassifierPorts {
  classify(input: ClassifyInput): Promise<AizuchiClassification>
  /** Called whenever the classification changes; the HUD displays it. */
  onResult(result: AizuchiClassification, input: ClassifyInput): void
  onFailure(error: unknown): void
}

export class AizuchiClassifierFeed {
  private latest: AizuchiClassification | null = null
  private inflight = false
  private pending: ClassifyInput | null = null
  private lastText = ''
  private generation = 0

  constructor(private readonly ports: ClassifierPorts) {}

  /** Called when capture starts. It discards the previous utterance's classification and any request still in flight. */
  reset(): void {
    this.generation++
    this.latest = null
    this.pending = null
    this.lastText = ''
  }

  /** Takes an updated partial transcript. Text identical to the last one is not sent again. */
  observe(input: ClassifyInput): void {
    const text = input.text.trim()
    if (text.length < MIN_CHARS || text === this.lastText) return
    this.lastText = text
    if (this.inflight) {
      this.pending = { ...input, text }
      return
    }
    void this.run({ ...input, text })
  }

  /** The latest classification, or null. The aizuchi is decided from this, because it cannot wait for a newer one. */
  current(): AizuchiClassification | null {
    return this.latest
  }

  /** True while the sentence is unfinished, which the VAD uses to extend its hangover. */
  holding(): boolean {
    return this.latest?.cls === 'hold'
  }

  private async run(input: ClassifyInput): Promise<void> {
    const generation = this.generation
    this.inflight = true
    try {
      const result = await this.ports.classify(input)
      if (generation === this.generation) {
        this.latest = nextClassification(this.latest, result)
        this.ports.onResult(this.latest, input)
      }
    } catch (error) {
      if (generation === this.generation) this.ports.onFailure(error)
    } finally {
      this.inflight = false
      const next = this.pending
      this.pending = null
      if (next && generation === this.generation) void this.run(next)
    }
  }
}
