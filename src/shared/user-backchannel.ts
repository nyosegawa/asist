import { BC_DET_THRESHOLD } from './maai-thresholds'

/**
 * Decides what the user's voice over the assistant's playback is: an aizuchi such as "うん" or "はい",
 * after which playback continues, a barge-in, after which playback stops and the app listens, or just
 * noise.
 *
 * The aizuchi detection model, bc_det, reports whether an aizuchi is being made right now, based on the
 * activity of the other channel. An aizuchi lasts 0.25 seconds at the median, so when the model is
 * available the barge-in decision waits a little to give detection a chance. If the voice keeps going
 * after an aizuchi verdict, the verdict becomes a barge-in.
 *
 * The same rules run in every conversation language. The only verdict that lets a voice pass is the one
 * bc_det gives, and bc_det belongs to MaAI, which runs for Japanese alone; elsewhere `bcDet` is always
 * null and every overlap ends as a barge-in or as noise, exactly as it does in Japanese while MaAI is
 * not prepared. The durations that remain are an upper bound on how long a voice may be and still be
 * let pass, so a value measured on Japanese aizuchi can only make a barge-in more likely, never
 * swallow one.
 */

export type OverlapVerdict = 'backchannel' | 'bargein' | 'noise' | 'undecided'

export interface OverlapInput {
  /** Total milliseconds of voiced audio, judged by energy. */
  voicedMs: number
  /** Total milliseconds confirmed to be human speech. It stays at zero for noise. */
  speechMs: number
  /**
   * The aizuchi detection probability on the user's channel, or null while the model is not ready or
   * its output is stale.
   */
  bcDet: number | null
  /** The voiced length required before a barge-in is confirmed. */
  confirmMs: number
  /** The minimum total of human speech required before a barge-in is confirmed. */
  minSpeechMs: number
}

/**
 * A voice longer than this is not an aizuchi: an aizuchi lasts 0.25 seconds at the median, and even
 * "うんうん" or "はいはい" stays under a second.
 */
export const USER_BACKCHANNEL_MAX_MS = 900
/** When the model is available, the barge-in decision waits this long to give detection a chance. */
const DETECTION_GRACE_MS = 450

export function classifyOverlap(input: OverlapInput): OverlapVerdict {
  const hasSpeech = input.speechMs >= input.minSpeechMs
  if (input.voicedMs > USER_BACKCHANNEL_MAX_MS && hasSpeech) return 'bargein'
  if (input.bcDet !== null && input.bcDet >= BC_DET_THRESHOLD && input.speechMs > 0) {
    return 'backchannel'
  }
  if (input.voicedMs < input.confirmMs) return 'undecided'
  // Voiced audio continues with no evidence of human speech, so it is noise.
  if (input.speechMs === 0) return 'noise'
  if (!hasSpeech) return 'undecided'
  if (input.bcDet !== null && input.voicedMs < DETECTION_GRACE_MS) return 'undecided'
  return 'bargein'
}
