/**
 * Embeddings for memory: the pinned model, the stdout protocol of the worker at
 * resources/embedding_worker.py, the encoding of vectors, and cosine.
 *
 * The model is the ONNX int8 build of multilingual-e5 small from intfloat, MIT, which covers about a
 * hundred languages and has 384 dimensions. One multilingual model serves every conversation language,
 * so that memories written in one language are still found after the language is changed. The ONNX and
 * the tokenizer come from Xenova's conversion, pinned by commit and sha256. Measured on 2026-09-21 on
 * Apple Silicon with one CPU thread: 2.2 ms to embed one utterance, about 730 MB resident, and 135 MB
 * to download. On the synthetic set (25 memories, 37 Japanese utterances) it finds the right memory
 * first for 86% of the Japanese utterances and all of the Spanish, Korean and Hindi ones. The
 * Japanese-only Ruri v3 130m finds 89% in Japanese, but 75% in Korean and 25% in Hindi. The prefixes
 * for a search query and a search passage are added by the worker.
 */

export interface EmbeddingFile {
  repo: string
  revision: string
  file: string
  sha256: string
  bytes: number
}

export interface EmbeddingModelSpec {
  /** The original model, whose name goes into the meta table of the database. */
  id: string
  label: string
  dim: number
  /** The kind of quantization. Changing it requires rebuilding every vector. */
  variant: string
  model: EmbeddingFile
  tokenizer: EmbeddingFile
  /**
   * The lowest cosine a dense hit may have. The scale of cosine differs per model, so the thresholds
   * live next to the model. The prefetched injection,
   * `utterance`, uses a higher one because precision matters there, while recall, `keyword`, uses a
   * lower one because the LLM can discard a result it does not want.
   */
  minCosine: { utterance: number; keyword: number }
}

export const EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: 'intfloat/multilingual-e5-small',
  label: 'multilingual-e5 small',
  dim: 384,
  variant: 'onnx-int8',
  model: {
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    file: 'onnx/model_quantized.onnx',
    sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    bytes: 118_308_185
  },
  tokenizer: {
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    file: 'tokenizer.json',
    sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    bytes: 17_082_730
  },
  // Measured on 2026-09-22 over 25 memories: a related Japanese pair scores 0.82 to 0.91, with a median
  // of 0.86, while the best score of an unrelated utterance is 0.838 in Japanese and 0.835 to 0.839 in
  // Spanish, Korean and Hindi. e5 packs every cosine into a narrow band, so the margin is small: at 0.84,
  // 86% of the related Japanese pairs survive. These are starting values, to be adjusted from the metrics.
  minCosine: { utterance: 0.84, keyword: 0.8 }
}

/** The model name stored in the database's meta table. When it changes, every vector is rebuilt. */
export function embeddingModelKey(spec: EmbeddingModelSpec = EMBEDDING_MODEL): string {
  return `${spec.id}@${spec.variant}-${spec.model.revision.slice(0, 7)}`
}

export const EMBEDDING_PROTOCOL_PREFIX = 'ASIST_JSON:'

export type EmbeddingKind = 'query' | 'document'

export type EmbeddingWorkerMessage =
  | { type: 'ready'; dim: number }
  | { type: 'result'; id: string; vectors: Float32Array[] }
  | { type: 'error'; id: string; error: string }
  | { type: 'fatal'; error: string }

/** Decodes base64 holding little-endian float32 back into a vector. */
export function decodeVector(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return vectorFromBytes(bytes)
}

/** Decodes a BLOB holding little-endian float32 back into a vector. */
export function vectorFromBytes(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(Math.floor(bytes.byteLength / 4))
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

/** Encodes a vector as a BLOB of little-endian float32. */
export function vectorToBytes(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true)
  return bytes
}

/**
 * Cosine similarity. The worker's vectors are already normalized, but the division is kept so that
 * vectors of any length give the right answer.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** Returns null for a line without the prefix, with invalid JSON, or with an unknown type. */
export function parseEmbeddingWorkerLine(line: string): EmbeddingWorkerMessage | null {
  const marker = line.indexOf(EMBEDDING_PROTOCOL_PREFIX)
  if (marker < 0) return null
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line.slice(marker + EMBEDDING_PROTOCOL_PREFIX.length))
  } catch {
    return null
  }
  if (typeof message !== 'object' || message === null) return null
  switch (message.type) {
    case 'ready': {
      const dim = Number(message.dim)
      return { type: 'ready', dim: Number.isFinite(dim) ? dim : 0 }
    }
    case 'result': {
      if (!Array.isArray(message.vectors)) return null
      return {
        type: 'result',
        id: String(message.id ?? ''),
        vectors: message.vectors.map((v) => decodeVector(String(v)))
      }
    }
    case 'error':
      return { type: 'error', id: String(message.id ?? ''), error: String(message.error ?? 'unknown') }
    case 'fatal':
      return { type: 'fatal', error: String(message.error ?? 'unknown') }
    default:
      return null
  }
}
