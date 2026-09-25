import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbeddingKind } from '@shared/memory-embedding'
import { createTranslator } from '@shared/i18n'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({
  userData: '',
  modelKey: 'model-a',
  running: vi.fn(() => false),
  ensureStarted: vi.fn(async () => true),
  embed: vi.fn<(texts: readonly string[], kind: EmbeddingKind) => Promise<Float32Array[]>>()
}))
vi.mock('@shared/memory-embedding', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/memory-embedding')>(),
  embeddingModelKey: () => mocks.modelKey
}))
vi.mock('../src/main/services/embedding', () => ({
  running: mocks.running,
  ensureStarted: mocks.ensureStarted,
  embed: mocks.embed,
  installationStatus: () => ({ runtimeInstalled: true, modelInstalled: true, running: mocks.running() })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] }
}))

type MemoryService = typeof import('../src/main/services/memory')
let service: MemoryService

beforeEach(async () => {
  vi.resetModules()
  mocks.running.mockReturnValue(false)
  mocks.embed.mockReset()
  mocks.modelKey = 'model-a'
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-memory-service-'))
  service = await import('../src/main/services/memory')
})

afterEach(() => {
  service.resetForTest()
  fs.rmSync(mocks.userData, { recursive: true, force: true })
})

const memoryFile = (...parts: string[]): string => path.join(mocks.userData, 'memory', ...parts)
const MUGI = '---\naliases: [ムギ, うちの猫]\n---\n# ムギ\n\n## 要約\n本人の猫。キジトラで窓辺によくいる。\n'
const MATSUBAKEN = '---\naliases: [松葉軒, ラーメン屋]\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。\n\n## 好み\n辛さは控えめが好みらしい。替え玉はしないようだ。\n'

function deferredVectors() {
  let resolve!: (vectors: Float32Array[]) => void
  const promise = new Promise<Float32Array[]>((done) => { resolve = done })
  return { promise, resolve }
}

async function enableEmbeddingWithOnePage(): Promise<string> {
  service.ensureLoaded()
  fs.writeFileSync(memoryFile('pages', 'ムギ.md'), MUGI)
  service.reindex()
  const { saveSettings } = await import('../src/main/services/settings')
  saveSettings({ memoryEmbeddingEnabled: true })
  mocks.running.mockReturnValue(true)
  return service.list()[0].id
}

describe('memory service', () => {

  it('turns every heading into a unit on reindex, follows a document rewrite and a delete in the index', async () => {
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    expect(service.reindex().units).toBe(2)
    const [summary] = service.list()
    expect(summary).toMatchObject({ kind: 'section', page: '松葉軒', heading: '要約', aliases: ['松葉軒', 'ラーメン屋'] })
    expect(service.documents().map((d) => [d.kind, d.title])).toEqual([['page', '松葉軒']])
    service.documentWrite('pages/松葉軒.md', MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。').replace(/## 好み[\s\S]*$/, ''))
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ id: summary.id, text: '本人の行きつけの店。' })
    expect((await service.search('松葉軒行った', { mode: 'utterance' }))[0]).toMatchObject({ record: { id: summary.id }, exact: true })
    expect(() => service.documentWrite('pages/松葉軒.md', '# 松葉軒\n## 好み\nx\n')).toThrow(ja('memory.check.frontmatterMissing', { file: 'pages/松葉軒.md' }))
    service.documentDelete('pages/松葉軒.md')
    expect(service.list()).toEqual([])
    expect(service.documents()).toEqual([])
  })

  it('indexes me.md like the other pages, so that the assistant recalls its own page through search', async () => {
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 話し方と癖\n語尾は柔らかく、冗談は控えめ。\n')
    service.reindex()
    expect(service.list()).toMatchObject([{ file: 'me.md', page: '私について', heading: '話し方と癖' }])
    expect((await service.search('私について'))[0]).toMatchObject({ record: { file: 'me.md' } })
  })

  it('builds the memory block from instruction.md alone, returns null without it, and freezes the block for five minutes', () => {
    service.ensureLoaded()
    expect(service.promptBlock(1_000_000)).toBeNull()
    fs.writeFileSync(memoryFile('instruction.md'), '# いつも覚えておくこと\n\n## この人について\n- 猫のムギと暮らす\n')
    fs.writeFileSync(memoryFile('me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 私は誰か\n落ち着いて話す。\n')
    expect(service.promptBlock(1_000_000 + 60_000)).toBeNull()
    expect(service.promptBlock(1_000_000 + 6 * 60_000)).toBe(`${service.MEMORY_HEADER.ja}\n## この人について\n- 猫のムギと暮らす`)
    expect(service.overview()).toMatchObject({ units: 1, pages: 1, lastFailure: null, unavailableReason: null })
  })

  it('embeds the documents while the embedder runs, and finds a paraphrase through the query vector', async () => {
    const vec = (text: string): Float32Array => new Float32Array([/ラーメン|麺/.test(text) ? 1 : 0, /猫/.test(text) ? 1 : 0, 0.1])
    const calls: Array<{ kind: string; texts: string[] }> = []
    const { saveSettings } = await import('../src/main/services/settings')
    saveSettings({ memoryEmbeddingEnabled: true })
    mocks.running.mockReturnValue(true)
    mocks.embed.mockImplementation(async (texts, kind) => {
      calls.push({ kind, texts: [...texts] })
      return texts.map(vec)
    })
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    fs.writeFileSync(memoryFile('pages', 'ムギ.md'), MUGI)
    service.reindex()
    await service.embedMissing()
    expect(calls.some((c) => c.kind === 'document' && c.texts.includes('松葉軒 要約: 本人の行きつけのラーメン屋。'))).toBe(true)
    const hits = await service.search('お昼は麺類の気分', { mode: 'utterance' })
    expect(hits.map((h) => h.record.heading)).toEqual(['要約'])
    expect(hits[0].via).toBe('dense')
    expect(calls.at(-1)).toEqual({ kind: 'query', texts: ['お昼は麺類の気分'] })
    expect(service.embeddingStatus()).toMatchObject({ embedded: 3, total: 3, enabled: true })
  })

  it('reports the conversion from the moment the setting starts it until every memory carries a vector', async () => {
    await enableEmbeddingWithOnePage()
    let started!: (ready: boolean) => void
    mocks.ensureStarted.mockReturnValueOnce(new Promise((resolve) => { started = resolve }))
    const held = deferredVectors()
    mocks.embed.mockReturnValueOnce(held.promise)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 0, total: 1 })

    const run = service.startEmbeddingIfEnabled()
    expect(service.embeddingStatus()).toMatchObject({ converting: true, embedded: 0 })
    started(true)
    await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
    expect(service.embeddingStatus()).toMatchObject({ converting: true, embedded: 0 })
    held.resolve([new Float32Array([1, 0])])
    expect(await run).toBe(true)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 1, total: 1 })
  })

  it('ends the conversion it reported when the worker cannot start', async () => {
    await enableEmbeddingWithOnePage()
    mocks.ensureStarted.mockResolvedValueOnce(false)
    expect(await service.startEmbeddingIfEnabled()).toBe(false)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 0, total: 1 })
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('computes no vectors while the setting is off, even when the worker is running', async () => {
    mocks.running.mockReturnValue(true)
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    service.reindex()
    expect(await service.embedMissing()).toBe(0)
    expect((await service.search('松葉軒', { mode: 'utterance' }))[0].exact).toBe(true)
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('passes an aborted search on to the embedder and builds no results from vectors that arrive after the abort', async () => {
    await enableEmbeddingWithOnePage()
    const held = deferredVectors()
    mocks.embed.mockReturnValueOnce(held.promise)
    const controller = new AbortController()
    const pending = service.search('ムギ', { mode: 'utterance' }, controller.signal)
    expect(mocks.embed).toHaveBeenCalledWith(['ムギ'], 'query', controller.signal)
    controller.abort()
    held.resolve([new Float32Array([1, 0])])
    await expect(pending).rejects.toBe(controller.signal.reason)
  })

  it('runs neither the embedder nor the text search for a search aborted before it started', async () => {
    await enableEmbeddingWithOnePage()
    const controller = new AbortController()
    controller.abort()
    await expect(service.search('ムギ', {}, controller.signal)).rejects.toBe(controller.signal.reason)
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('discards a vector computed from a body that was edited meanwhile and computes it again from the new body', async () => {
    const id = await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise).mockResolvedValueOnce([new Float32Array([0, 1])])
    const pending = service.embedMissing()
    expect(mocks.embed).toHaveBeenCalledOnce()

    expect(service.get(id)).not.toBeNull()
    service.documentWrite('pages/ムギ.md', MUGI.replace('本人の猫。キジトラで窓辺によくいる。', 'チェスを楽しんでいる。'))
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(1)
    expect(mocks.embed.mock.calls).toEqual([
      [['ムギ 要約: 本人の猫。キジトラで窓辺によくいる。'], 'document'],
      [['ムギ 要約: チェスを楽しんでいる。'], 'document']
    ])
    mocks.embed.mockResolvedValue([new Float32Array([1, 0])])
    expect(await service.search('以前の話題', { mode: 'utterance' })).toEqual([])
    mocks.embed.mockResolvedValue([new Float32Array([0, 1])])
    expect((await service.search('現在の話題', { mode: 'utterance' }))[0]).toMatchObject({ via: 'dense', record: { text: 'チェスを楽しんでいる。' } })
  })

  it('keeps a memory deleted during the computation out of the index and the vectors once it finishes', async () => {
    const id = await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise)
    const pending = service.embedMissing()

    expect(service.get(id)).not.toBeNull()
    service.documentDelete('pages/ムギ.md')
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(0)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 0, total: 0 })
    expect(mocks.embed).toHaveBeenCalledOnce()
  })

  it('stores no result of the earlier model when the model changes during the computation, and computes again with the current one', async () => {
    await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    const second = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const pending = service.embedMissing()

    mocks.modelKey = 'model-b'
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(0)
    expect(mocks.embed).toHaveBeenCalledTimes(2)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 0, total: 1 })
    const recomputed = service.embedMissing()
    second.resolve([new Float32Array([0, 1])])
    expect(await recomputed).toBe(1)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 1, total: 1, model: 'model-b' })
  })

  it('reports why memory alone is unavailable when its directory cannot be created, and leaves the conversation running', () => {
    fs.writeFileSync(path.join(mocks.userData, 'memory'), 'not a directory')
    expect(service.unavailableReason()).toContain(ja('memory.errors.openFailed', { message: '' }).trim())
    expect(service.promptBlock()).toBeNull()
    expect(service.overview().unavailableReason).toContain(ja('memory.errors.openFailed', { message: '' }).trim())
    expect(() => service.list()).toThrow('[asist:memory.errors.openFailed')
  })
})
