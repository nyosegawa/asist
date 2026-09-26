import { nextClassification, type AizuchiClassification } from '@shared/aizuchi-classifier'
import { PartialLookahead } from './lookahead'

/**
 * Runs the partial transcripts through the aizuchi classifier, a worker in the main process, and
 * holds the latest classification for the moment speech ends. The requests run through
 * PartialLookahead, one at a time within a capture. Switching classification follows the rule in
 * nextClassification, because a classification that flips on every partial transcript makes the
 * aizuchi choice waver.
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
  private readonly lookahead: PartialLookahead<ClassifyInput, AizuchiClassification>

  constructor(ports: ClassifierPorts) {
    this.lookahead = new PartialLookahead({
      request: (input) => ports.classify(input),
      fold: nextClassification,
      onResult: (result, input) => ports.onResult(result, input),
      onFailure: (error) => ports.onFailure(error)
    })
  }

  /** Called when capture starts. It discards the previous utterance's classification and any request still in flight. */
  reset(): void {
    this.lookahead.reset()
  }

  /** Takes an updated partial transcript. Text identical to the last one is not sent again. */
  observe(input: ClassifyInput): void {
    const text = input.text.trim()
    if (text.length >= MIN_CHARS) this.lookahead.send({ ...input, text })
  }

  /** The latest classification, or null. The aizuchi is decided from this, because it cannot wait for a newer one. */
  current(): AizuchiClassification | null {
    return this.lookahead.current()
  }

  /** True while the sentence is unfinished, which the VAD uses to extend its hangover. */
  holding(): boolean {
    return this.lookahead.current()?.cls === 'hold'
  }
}
