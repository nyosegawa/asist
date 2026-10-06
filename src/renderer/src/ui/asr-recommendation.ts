import { asrRecommendationSize, type AsrModelChoice } from '@shared/asr-models'
import type { SetupStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import type { SpeechBackend } from '@shared/platform'

/**
 * Why the recommended speech recognition model suits this machine, from the memory the main process
 * reports: the Mac's own on metal, the GPU's on vulkan.
 */
export function asrRecommendationReason(t: Translate, backend: SpeechBackend, asr: NonNullable<SetupStatus['asr']>): string {
  return t(`speechRecognition.recommendation.${backend}.${asrRecommendationSize(backend, asr.totalMemoryGb)}`, { memoryGb: asr.totalMemoryGb })
}

/** A model as the setup and the voice page list it, with what preparing it downloads. */
export function asrChoiceLabel(t: Translate, formatLocale: string, choice: AsrModelChoice): string {
  return t('speechRecognition.modelOption', { model: choice.label, sizeGb: new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 }).format(choice.sizeGb) })
}
