import type { PinnedFile } from './pinned-file'

/**
 * The models of speech.cpp's catalog that ASIST runs, by the name the catalog gives each. The bundled `speech` pins
 * the file of every model, by repository, commit, size and SHA-256, so that a speech.cpp release brings the files it
 * was checked with; ASIST reads them from `speech models --json` and decides only which models it offers.
 */
export const SPEECH_MODEL_NAMES = [
  'qwen3-tts-0.6b',
  'qwen3-tts-1.7b',
  'irodori-tts-mf',
  'qwen3-asr-1.7b',
  'qwen3-asr-0.6b',
  'parakeet-tdt_ctc-0.6b-ja',
  'reazonspeech-v2',
  'parakeet-tdt-0.6b-v3'
] as const

export type SpeechModelName = (typeof SPEECH_MODEL_NAMES)[number]

/** The file ASIST runs of each model: the one of the type the model's name alone means in the catalog. */
export type SpeechCatalog = Readonly<Record<SpeechModelName, PinnedFile>>

/**
 * The catalog in the output of `speech models --json`, one JSON object on stdout alone. Throws when the output does
 * not read or lacks a model ASIST runs, which a bundled `speech` that does not match the app would give.
 */
export function parseSpeechCatalog(output: string): SpeechCatalog {
  const models = (JSON.parse(output) as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) throw new Error('speech models --json printed no list of models')
  const files = {} as Record<SpeechModelName, PinnedFile>
  for (const name of SPEECH_MODEL_NAMES) {
    const model = (models as Array<Record<string, unknown>>).find((one) => one.name === name)
    if (!model) throw new Error(`the catalog of the bundled speech has no model ${name}`)
    const { repository, revision, type } = model
    const file = Array.isArray(model.files) ? (model.files as Array<Record<string, unknown>>).find((one) => one.type === type) : undefined
    if (typeof repository !== 'string' || typeof revision !== 'string' || !file) throw new Error(`the catalog gives ${name} without the file of its type`)
    const { file: fileName, size, sha256 } = file
    if (typeof fileName !== 'string' || typeof size !== 'number' || typeof sha256 !== 'string') throw new Error(`the catalog gives the file of ${name} without its name, size or SHA-256`)
    files[name] = { repo: repository, revision, file: fileName, bytes: size, sha256 }
  }
  return files
}
