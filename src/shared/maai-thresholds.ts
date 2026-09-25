/**
 * Thresholds for the MaAI models, measured on 2026-09-07 with vap-test on 34 minutes of meeting audio
 * turned into pseudo two-channel audio. 95 turn shifts and 128 holds were evaluated with
 * eval_shift_hold.py, and calibrate_runtime.py fitted ASIST's dynamic hangover rule.
 *
 * With vap_jp_kyoto Mimi at 12.5 Hz over a 20-second window, an early confirmation at 0.8 came closest
 * to 10% false firing during silence: 0.8 alone gave 10.9% false firing, 38.9% of shifts detected
 * before the other speaker started, and a p50 firing time of 560 ms. The hold threshold of 0.3 was
 * chosen so that shifts are not delayed too much, because at 320-400 ms of silence in a true shift the
 * lowest quartile of EoT is about 0.35. With the rule of 200 ms sustained, 300 ms early and 900 ms
 * extended, false firing on holds fell from 75.0% to 54.7% and detection before the other speaker
 * started rose from 55.8% to 62.1%, compared with a fixed 600 ms. The p50 confirmation time was 640 ms
 * either way, in frames of 80 ms.
 *
 * Aizuchi and nods were evaluated with eval_bc.py on CPC at 10 Hz over a 5-second window. With only 18
 * positives and 288 negative time points, a probability threshold alone fires too often, so the
 * conditions on mid-sentence pauses, utterance length and a 5-second interval are used as well. Measure
 * again after changing the model or the encoder. These numbers come from the data above; accuracy in
 * daily use has to be confirmed separately. VadSegmenter, listening aizuchi and nods read from here.
 */

/**
 * Turn taking with vap_jp_kyoto Mimi at 12.5 Hz: a silence counts as finished once EoT stays at or
 * above this probability.
 */
export const VAP_EOT_CONFIRM = 0.8
/** An EoT at or below this probability means the silence still has speech coming, so the wait extends. */
export const VAP_EOT_HOLD_BELOW = 0.3

/**
 * Aizuchi with bc_2type CPC at 10 Hz: the probability at which an encouraging aizuchi fires on the
 * model alone.
 */
export const BC_REACT_THRESHOLD = 0.5
/**
 * The threshold used when the partial recognition text is at a boundary, that is, in a connective or
 * sentence-final form. The model alone hits only 44% at 0.5, so the text boundary acts as a second vote
 * and fewer opportunities are missed. 0.35 is a starting point taken from the distribution over the
 * frames just before the positives; adjust it from the hit rate of listening aizuchi in the metrics.
 */
export const BC_REACT_WITH_TEXT_THRESHOLD = 0.35
/**
 * An aizuchi of admiration or agreement. It rarely rises, so the threshold is low, and it wins over the
 * encouraging one when both hold.
 */
export const BC_EMO_THRESHOLD = 0.3

/**
 * Aizuchi detection with bc_det Mimi at 12.5 Hz: whether a short sound from the user is an aizuchi. On
 * MaAI's Japanese development set the event-level F1 peaks at 0.45, and 0.5 is not the optimum because
 * only 4% of the frames are aizuchi. It is unverified on ASIST's own audio; adjust it from how often
 * playback was let through and how often it was stopped, in the metrics.
 */
export const BC_DET_THRESHOLD = 0.45

/**
 * Nods with the nod model on CPC at 10 Hz. A long nod has an AUC of 0.86, and 0.55 gives about seven
 * rises per minute while the user speaks.
 */
export const NOD_LONG_THRESHOLD = 0.55
/** A short nod, weaker at an AUC of 0.63 to 0.69. 0.40 holds it to about four per minute. */
export const NOD_SHORT_THRESHOLD = 0.4
