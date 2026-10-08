import { parseSpeechCatalog, type SpeechCatalog } from '../../src/shared/speech-catalog'
import listed from '../fixtures/speech-models.json'

/**
 * What `speech models --json` of speech.cpp 0.8.2 printed, without the paths of the machine it ran on. It is
 * imported rather than read, so that a test that mocks node:fs still gets it.
 */
export const SPEECH_MODELS_OUTPUT = JSON.stringify(listed)

/** The files of the local speech models as that catalog pins them. */
export const TEST_SPEECH_CATALOG: SpeechCatalog = parseSpeechCatalog(SPEECH_MODELS_OUTPUT)

/** The renderer's catalog, for `vi.mock('@/speech-catalog', () => import('./helpers/speech-catalog'))`. */
export const speechCatalog = (): SpeechCatalog => TEST_SPEECH_CATALOG
export const loadSpeechCatalog = async (): Promise<void> => {}

/** execFileSync for a mock of node:child_process, which answers `speech models --json` and nothing else. */
export function listSpeechModels(_program: string, args: readonly string[]): string {
  if (args.join(' ') !== 'models --json') throw new Error(`a test ran ${args.join(' ')}, which the mock does not answer`)
  return SPEECH_MODELS_OUTPUT
}
