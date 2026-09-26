import type { SpeechSegment } from '@shared/ipc'

/** The index main's turn gives the filler it plays while a tool runs. */
const WORK_FILLER_INDEX = 998

/** Whether a segment is a sentence of the answer itself, rather than a one-off clip (index -1) or the work filler. */
export function isAnswerSegment(segment: Pick<SpeechSegment, 'index'>): boolean {
  return segment.index >= 0 && segment.index !== WORK_FILLER_INDEX
}
