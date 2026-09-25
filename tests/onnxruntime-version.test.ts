import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = (path: string): { version: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(path, 'utf8'))

describe('onnxruntime-web', () => {
  // The workers hand ONNX Runtime the wasm files of the top-level onnxruntime-web, while
  // transformers runs the JavaScript of the version it depends on; two versions do not load together.
  it('is the version transformers depends on, so the Whisper worker loads matching wasm files', () => {
    const transformers = packageJson('node_modules/@huggingface/transformers/package.json')
    const runtime = packageJson('node_modules/onnxruntime-web/package.json')
    expect(transformers.dependencies?.['onnxruntime-web']).toBe(runtime.version)
  })
})
