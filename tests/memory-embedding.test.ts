import { describe, expect, it } from 'vitest'
import { EMBEDDING_MODEL, cosine, embeddingModelKey, parseEmbeddingWorkerLine, vectorToBytes } from '@shared/memory-embedding'

const b64 = (values: number[]): string => {
  const bytes = vectorToBytes(new Float32Array(values))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe('embedding vectors', () => {

  it('scores 1 for vectors of the same direction and 0 for orthogonal ones, whatever their length', () => {
    const a = new Float32Array([1, 0])
    expect(cosine(a, new Float32Array([2, 0]))).toBeCloseTo(1)
    expect(cosine(a, new Float32Array([0, 1]))).toBeCloseTo(0)
    expect(cosine(a, new Float32Array([0, 0]))).toBe(0)
  })

  it('gives another model key when the model, the quantization or the ONNX commit changes, so that the vectors are rebuilt', () => {
    const base = embeddingModelKey()
    expect(embeddingModelKey({ ...EMBEDDING_MODEL, id: 'another/model' })).not.toBe(base)
    expect(embeddingModelKey({ ...EMBEDDING_MODEL, variant: 'onnx-fp16' })).not.toBe(base)
    expect(embeddingModelKey({ ...EMBEDDING_MODEL, model: { ...EMBEDDING_MODEL.model, revision: '0'.repeat(40) } })).not.toBe(base)
    expect(embeddingModelKey({ ...EMBEDDING_MODEL, tokenizer: { ...EMBEDDING_MODEL.tokenizer, bytes: 1 } })).toBe(base)
  })
})

describe('parseEmbeddingWorkerLine', () => {
  it('reads ready, result, error and fatal lines, and decodes the vectors of a result', () => {
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{"type":"ready","dim":384}')).toEqual({ type: 'ready', dim: 384 })
    const result = parseEmbeddingWorkerLine(
      `ASIST_JSON:{"type":"result","id":"q1","vectors":["${b64([1, 0])}","${b64([0, 1])}"]}`
    )
    expect(result?.type).toBe('result')
    if (result?.type !== 'result') throw new Error('unreachable')
    expect(result.id).toBe('q1')
    expect(result.vectors.map((v) => [...v])).toEqual([
      [1, 0],
      [0, 1]
    ])
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{"type":"error","id":"q2","error":"unknown kind"}')).toEqual({
      type: 'error',
      id: 'q2',
      error: 'unknown kind'
    })
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{"type":"fatal","error":"no model"}')).toEqual({
      type: 'fatal',
      error: 'no model'
    })
  })

  it('returns null for a line without the prefix, for broken JSON, for an unknown type and for a result without vectors', () => {
    expect(parseEmbeddingWorkerLine('Loading weights...')).toBeNull()
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{not json')).toBeNull()
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{"type":"state"}')).toBeNull()
    expect(parseEmbeddingWorkerLine('ASIST_JSON:{"type":"result","id":"x"}')).toBeNull()
  })
})
