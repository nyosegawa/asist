#!/usr/bin/env node
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { IRODORI_TTS_MODEL, IRODORI_TTS_VOICE_IDS } from '../src/shared/tts-models.ts'
import { modelPath, speechProgram } from './aizuchi-clips/speech.mjs'
import { run } from './resources/shared.mjs'

/*
 * Writes resources/irodori-voices/<voice>.voice.gguf, the voices ASIST ships for Irodori-TTS, from the reference
 * recordings speech-bench made (voice-<voice>.wav):
 *
 *   node scripts/irodori-voices.mjs [references folder]
 *
 * The references folder defaults to ~/speech-bench-data/references. Each voice file holds the reference's codec
 * latent and the hash of the codec it was made with, and a model of another codec refuses it, so the voices are
 * made again whenever the pin moves to another codec or speech.cpp changes the form of a voice file. They are made
 * with `speech voice` on the CPU, where the latent matches the official encoder to 99 dB; on a GPU it differs by
 * device. speech is the one prepare-resources bundles, and the model is read from the files the app has prepared,
 * or from the folder ASIST_SPEECH_MODELS names.
 */

const root = path.resolve(import.meta.dirname, '..')
const references = process.argv[2] ?? path.join(homedir(), 'speech-bench-data', 'references')
const out = path.join(root, 'resources', 'irodori-voices')

fs.mkdirSync(out, { recursive: true })
for (const voice of IRODORI_TTS_VOICE_IDS) {
  const reference = path.join(references, `voice-${voice}.wav`)
  run(speechProgram(), ['voice', modelPath(IRODORI_TTS_MODEL.model), reference, path.join(out, `${voice}.voice.gguf`), '--device', 'cpu'])
}
console.log(`irodori voices: ${IRODORI_TTS_VOICE_IDS.length} files → ${path.relative(root, out)}`)
