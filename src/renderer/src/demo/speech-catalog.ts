import type { SpeechCatalog } from '@shared/speech-catalog'

/** The files of the local speech models as the catalog of speech.cpp 0.8.2 pins them, which the demo's screens read. */
export const DEMO_SPEECH_CATALOG: SpeechCatalog = {
  'qwen3-tts-0.6b': { repo: 'sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF', revision: '2d4d7aea381798737778af3a375e007050029689', file: 'Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf', bytes: 1_213_534_464, sha256: 'f606ea3981aa42762b16db9a94826d2d560eb60f0b102001618f40d5a2f78cc6' },
  'qwen3-tts-1.7b': { repo: 'sakasegawa/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF', revision: '0e6b15bd7e51aaee4363ccb128c89730addc5942', file: 'Qwen3-TTS-12Hz-1.7B-CustomVoice-Q8_0.gguf', bytes: 2_287_780_352, sha256: '1bc0ef69547c003507b6536639a6080c8856382f4d0963b15d4475528330592d' },
  'irodori-tts-mf': { repo: 'sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF', revision: '69d307a472a1708c5637edcfe376d31c2685829d', file: 'Irodori-TTS-866M-MF-v4.1-F16.gguf', bytes: 1_920_321_792, sha256: 'e237dc3eefe469b8bba87872beacf12fb7fe00dbdf85767edca8ec04ab910d13' },
  'qwen3-asr-1.7b': { repo: 'sakasegawa/Qwen3-ASR-1.7B-GGUF', revision: 'd1b1ebcc7569cae80209262a5fc147d65bebd7bd', file: 'Qwen3-ASR-1.7B-Q8_0.gguf', bytes: 2_176_109_216, sha256: '5f219b78a1d9c3b9e97da27708b36f8a0bc1bfc1650b541c0a6dbaf87c9a62d0' },
  'qwen3-asr-0.6b': { repo: 'sakasegawa/Qwen3-ASR-0.6B-GGUF', revision: '450483d7e7ffc6ddb47048094247db782f7dda04', file: 'Qwen3-ASR-0.6B-Q8_0.gguf', bytes: 841_502_336, sha256: '416e10c15b4a3d9002bd337d18fc450233fdf68502b6e10d1379d2789838afd0' },
  'parakeet-tdt_ctc-0.6b-ja': { repo: 'sakasegawa/parakeet-tdt_ctc-0.6b-ja-GGUF', revision: '48060c6e292b01c84edac8988db0163fd41d3fe2', file: 'parakeet-tdt_ctc-0.6B-ja-F16.gguf', bytes: 1_240_656_832, sha256: '71ddc10381a9d3b59e18fbc51422059293f1268676b1ca62adb45b791df05497' },
  'reazonspeech-v2': { repo: 'sakasegawa/reazonspeech-nemo-v2-GGUF', revision: 'cb9e436cf3f9d9563c610cb5318adcfc5c0fe098', file: 'reazonspeech-nemo-619M-v2-F16.gguf', bytes: 1_240_465_696, sha256: '1492147d7d18fbb0503db2cbbb05df4932cb3451e391524c6a2411632e4823bf' },
  'parakeet-tdt-0.6b-v3': { repo: 'sakasegawa/parakeet-tdt-0.6b-v3-GGUF', revision: '304eaf83fc16e3087425b61b6652c4eafe003dc4', file: 'parakeet-tdt-0.6B-v3-F16.gguf', bytes: 1_255_370_688, sha256: '7b74de31ac48427934104f0d074613f8d759d7d108777c114476346789d94426' }
}
