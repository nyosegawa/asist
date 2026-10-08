import fs from 'node:fs'
import path from 'node:path'
import { parseSpeechCatalog, type SpeechCatalog } from '../../src/shared/speech-catalog'

/** What `speech models --json` of speech.cpp 0.8.2 printed, without the paths of the machine it ran on. */
export const SPEECH_MODELS_OUTPUT = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'speech-models.json'), 'utf8')

/** The files of the local speech models as that catalog pins them. */
export const TEST_SPEECH_CATALOG: SpeechCatalog = parseSpeechCatalog(SPEECH_MODELS_OUTPUT)
