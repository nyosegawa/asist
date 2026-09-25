import os from 'node:os'
import {
  asrModelLabel,
  isAsrModel,
  recommendAsrModel,
  resolveAsrModel,
  type AsrModel,
  type ResolvedAsrModel
} from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import { t } from './i18n'
import { getSettings } from './settings'
import * as mlx from './mlx-asr'

export function hardwareRecommendation() {
  return recommendAsrModel(os.totalmem())
}

export function resolvedModel(selected: AsrModel = getSettings().asrModel): ResolvedAsrModel {
  return resolveAsrModel(selected, hardwareRecommendation())
}

export async function installationStatus(selected: AsrModel = getSettings().asrModel) {
  const recommendation = hardwareRecommendation()
  const resolved = resolveAsrModel(selected, recommendation)
  return {
    selectedModel: selected,
    resolvedModel: resolved,
    recommendedModel: recommendation.recommendedModel,
    label: asrModelLabel(resolved),
    totalMemoryGb: recommendation.totalMemoryGb,
    ...mlx.installationStatus(resolved),
    ready: await mlx.available(resolved)
  }
}

export function available(): Promise<boolean> {
  return mlx.available(resolvedModel())
}

export function ensureServer(): Promise<boolean> {
  return mlx.ensureServer(resolvedModel())
}

export async function revive(): Promise<boolean> {
  const model = resolvedModel()
  return (await mlx.available(model)) || mlx.ensureServer(model)
}

export function transcribe(samples: Float32Array, requestId?: string): Promise<string> {
  return mlx.transcribe(resolvedModel(), samples, requestId)
}

export function transcribePartial(samples: Float32Array): Promise<string> {
  return mlx.transcribePartial(resolvedModel(), samples)
}

export const cancelTranscription = mlx.cancelTranscription

export function switchModel(): Promise<boolean> {
  mlx.stop()
  return ensureServer()
}

export function prepareModel(
  selected: AsrModel,
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (!isAsrModel(selected)) {
    return Promise.resolve({ ok: false, message: t('speechRecognition.errors.unknownModel') })
  }
  return mlx.prepare(resolvedModel(selected), onProgress)
}

export const cancelPreparation = mlx.cancelPreparation
