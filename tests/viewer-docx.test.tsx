// @vitest-environment happy-dom
import { createTranslator } from '@shared/i18n'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { cleanDocxHtml } from '@/panels/viewers/docx-html'
import { FileViewer } from '@/panels/viewers'
import { useToastStore } from '@/state/stores'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'
import { ANY_VALUE, withAnyValue } from './helpers/message'
import { entryRanges } from './helpers/zip'

/**
 * The Word viewer. Cleaning the HTML runs on string fixtures. The rendering runs the preview page's Word kind in
 * this process, on a channel that hands messages over as they are, and reads the files from a server that answers
 * Range requests as asist-file does and counts the bytes it sends. Pictures are decoded by a stand-in for
 * createImageBitmap and drawn into a stand-in for a canvas's 2D context, since happy-dom has neither.
 */

vi.mock('@/panels/viewers/preview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/viewers/preview-client')>()
  const { servePreview } = await import('@/preview/serve')
  /** One end of a channel between the viewer and the page, which hands each message over on a later task. */
  class Port extends EventTarget {
    other: Port | null = null
    postMessage(data: unknown): void {
      setTimeout(() => this.other!.dispatchEvent(Object.assign(new Event('message'), { data })))
    }
    start(): void {}
    close(): void {}
  }
  const client = actual.createPreviewClient(() => {
    const [viewer, page] = [new Port(), new Port()]
    viewer.other = page
    page.other = viewer
    servePreview(page as unknown as MessagePort, { './methods/docx.ts': () => import('@/preview/methods/docx') })
    return { port: viewer as unknown as MessagePort, gone: new Promise<void>(() => undefined), remove: () => undefined }
  })
  return { ...actual, openPreviewDocument: client.open }
})

const t = createTranslator('ja-JP')
const DEMO_DIR = resolve('src/renderer/demo-public')
const itemOf = (kind: FileItem['kind']): FileItem => DEMO_OFFICE_ITEMS.find((item) => item.kind === kind)!
/** The size of a picture, which is four times the 64 KB a reader takes from the end of the file first. */
const PICTURE = 256 * 1024

let container: HTMLDivElement
let root: Root
const openExternal = vi.fn(async (_url: string) => {})
/** The bytes the server sent, and the Range header of each request. */
let sent = 0
let ranges: string[] = []
/** What the stand-ins decoded and drew, and the errors the next decodings throw instead. */
let decoded: Array<{ size: number }> = []
let drawn: unknown[] = []
let decodeFailures: Error[] = []
/** Whether the server refuses the next request for a range that is not the end of the file. */
let refuseNext = false
/** A URL of its own for each file, so that no test meets a document another test opened. */
let fileNumber = 0

/** How many times a file was served, which stands for its time of change in the ETag. */
let saved = 0

/**
 * Serves a file at every URL as asist-file answers a Range request: a suffix range, a range, or the whole file,
 * with an ETag of its length and its time of change. Each call stands for the file saved again.
 */
function serve(file: Uint8Array): void {
  const etag = `"${file.length}-${++saved}"`
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const header = new Headers(init?.headers).get('range') ?? ''
    ranges.push(header)
    if (refuseNext && !header.startsWith('bytes=-')) {
      refuseNext = false
      return new Response('busy', { status: 503 })
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(header)
    const suffix = range?.[1] === ''
    const start = !range ? 0 : suffix ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = !range || suffix || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    if (!range || start > end) {
      sent += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(start, end + 1)
    sent += body.length
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, ETag: etag } })
  })
}

/** Decodes any picture as a photo of 2000 x 1500, and scales it to the size it is asked for. */
class FakeBitmap {
  constructor(
    readonly width: number,
    readonly height: number
  ) {}
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  vi.stubGlobal('ImageBitmap', FakeBitmap)
  vi.stubGlobal('createImageBitmap', async (source: Blob | FakeBitmap, options?: ImageBitmapOptions) => {
    if (source instanceof Blob) {
      decoded.push({ size: source.size })
      const failure = decodeFailures.shift()
      if (failure) throw failure
      return new FakeBitmap(2000, 1500)
    }
    return new FakeBitmap(options!.resizeWidth!, options!.resizeHeight!)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (bitmap: unknown) => drawn.push(bitmap) }) as never)
  vi.stubGlobal('window', Object.assign(window, { api: { openExternal } }))
  sent = 0
  ranges = []
  decoded = []
  drawn = []
  decodeFailures = []
  refuseNext = false
  openExternal.mockClear()
  useToastStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Renders the viewer, and waits until `ready` holds for what it shows. */
async function render(item: FileItem, mode: 'card' | 'focus', ready: (frame: HTMLElement) => boolean = (frame) => !frame.textContent?.includes(t('files.viewer.loading'))): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />)
  })
  await settle(() => ready(container))
  return container.querySelector<HTMLElement>('.fv-frame') ?? container
}

/** Lets the viewer and the page work until `done` holds, or fails after a few seconds saying what it waited for. */
async function settle(done: () => boolean, what = 'the viewer to finish loading'): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
  expect(done(), `waited for ${what}`).toBe(true)
}

const docxItem = (url: string, sizeBytes: number): FileItem => ({ ...itemOf('docx'), url, sizeBytes })
const nextUrl = (): string => `/docs/${++fileNumber}.docx`

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const CONTENT_TYPES =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const PACKAGE_RELS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
/** A paragraph holding one picture, as Word writes it, which refers to the picture's file through rel. */
const drawing = (rel: string, name: string): string =>
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
  `<wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="${name}" descr="${name}"/>` +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

/** A docx of the body's blocks, with the photos it names stored as Word stores them, in its media folder. */
async function docxOf(blocks: string[], { photos = [] as string[], rels = '', parts = {} as Record<string, string>, store = false } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', PACKAGE_RELS)
  zip.file('word/document.xml', `<w:document ${W} ${R}><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`)
  const pictureRels = photos.map((photo, i) => `<Relationship Id="rIdP${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${photo}"/>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pictureRels.join('')}${rels}</Relationships>`)
  for (const [name, content] of Object.entries(parts)) zip.file(name, content, { compression: 'STORE' })
  for (const photo of photos) zip.file(`word/media/${photo}`, randomBytes(PICTURE), { compression: 'STORE' })
  return zip.generateAsync({ type: 'uint8array', compression: store ? 'STORE' : 'DEFLATE' })
}

/** Puts an element at a place, from top to bottom, as the layout would. */
function place(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top }) as DOMRect
}

/** Moves a picture and lets the watcher and the page act on where it is now. */
async function moveTo(canvas: Element, top: number): Promise<void> {
  place(canvas, top, 150)
  await act(async () => LayoutIntersectionObserver.update())
  await act(async () => new Promise((r) => setTimeout(r, 50)))
}

const serialized = (html: string): string => {
  const box = document.createElement('div')
  box.append(cleanDocxHtml(html))
  return box.innerHTML
}

describe('cleaning the docx HTML', () => {
  it('drops script and on* attributes, keeps only the allowed elements, removes unsafe links, and turns each picture of the document into a canvas that names it', () => {
    const picture = `data:image/png;base64,${btoa('word/media/image1.png')}`
    const html =
      '<h1 onclick="x()">題</h1><script>alert(1)</script><p style="color:red">本文 <strong>太字</strong> <span class="a">囲み</span></p>' +
      '<a href="javascript:alert(1)">危険</a><a href="https://example.com/a">安全</a>' +
      `<img src="https://evil/x.png"><img src="${picture}" alt="図" onerror="x()">` +
      '<table><tr><td colspan="2" bgcolor="red">セル</td></tr></table><iframe></iframe>'
    expect(serialized(html)).toBe(
      '<h1>題</h1><p>本文 <strong>太字</strong> 囲み</p>危険<a href="https://example.com/a">安全</a>' +
        '<canvas class="fv-doc-picture" data-picture="word/media/image1.png" role="img" aria-label="図"></canvas>' +
        '<table><tbody><tr><td colspan="2">セル</td></tr></tbody></table>'
    )
  })

  it('keeps mail links, links to places in the document and the ids they point to, but no id of the page around it', () => {
    const html =
      '<a href="mailto:team@example.com">mail</a><a href="#docx-_Toc1">toc</a><a id="docx-_Toc1"></a>' +
      '<ol><li id="docx-footnote-1">note</li></ol><a href="#root">app</a><p id="root">page</p><a href="file:///etc/passwd">file</a>'
    expect(serialized(html)).toBe(
      '<a href="mailto:team@example.com">mail</a><a href="#docx-_Toc1">toc</a><a id="docx-_Toc1"></a>' +
        '<ol><li id="docx-footnote-1">note</li></ol>app<p>page</p>file'
    )
  })
})

describe('Word viewer rendering', () => {
  it('renders the headings, emphasis, lists and tables of a docx into .fv-doc', async () => {
    serve(readFileSync(resolve(DEMO_DIR, `.${itemOf('docx').url}`)))
    const frame = await render(itemOf('docx'), 'card')
    const doc = frame.querySelector('.fv-doc')!
    expect(doc.querySelector('h1')?.textContent).toBe('競合サービスの比較')
    expect(doc.querySelector('strong')?.textContent).toBe('差が大きいのは同時接続数の上限')
    expect([...doc.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['料金と無料枠の有無', '同時接続の上限', 'サポートの応答時間'])
    expect(doc.querySelectorAll('table tr')).toHaveLength(3)
    expect(doc.querySelectorAll('table tr:first-child td')).toHaveLength(3)
    expect(doc.querySelector('script, style, [onclick]')).toBeNull()
    expect(frame.textContent).not.toContain(t('files.viewer.docxMore'))
  })

  it('reads a picture only once it comes within a screen of the card, at the width of the column, and lets it go once it leaves', async () => {
    const file = await docxOf([paragraph('調査の結果'), drawing('rIdP0', '図1'), paragraph('次の段落'), drawing('rIdP1', '写真')], { photos: ['image1.jpeg', 'photo.jpeg'] })
    serve(file)
    const frame = await render(docxItem(nextUrl(), file.length), 'card')
    expect(sent).toBeLessThan(PICTURE)
    // The card's frame shows 420 px from the top of the window, and a picture within one more screen is near.
    place(frame.querySelector('.fv-scroll')!, 0, 420)
    Object.defineProperty(frame.querySelector('.fv-doc')!, 'clientWidth', { value: 400 })
    const [first, second] = frame.querySelectorAll('canvas')
    place(second, 5000, 150)
    await moveTo(first, 3000)
    expect([decoded.length, drawn.length]).toEqual([0, 0])
    expect(sent).toBeLessThan(PICTURE)

    await moveTo(first, 600)
    await settle(() => first.getAttribute('data-state') === 'drawn', 'the picture to be drawn')
    expect(decoded).toEqual([{ size: PICTURE }])
    expect(drawn).toHaveLength(1)
    // The photo of 2000 x 1500 is drawn at the column's 400 device pixels, in a box of its own width and shape.
    expect([first.width, first.height, first.style.width, first.style.aspectRatio]).toEqual([400, 300, '2000px', '2000 / 1500'])
    expect(sent).toBeGreaterThanOrEqual(PICTURE)
    expect(sent).toBeLessThan(2 * PICTURE)

    await moveTo(first, 3000)
    expect([first.width, first.height, first.getAttribute('data-state')]).toEqual([0, 0, null])
    expect(first.style.aspectRatio).toBe('2000 / 1500')
    expect(decoded).toHaveLength(1)
  })

  it('says a document whose XML is far beyond any real one is too large to show here, having read nothing past its directory', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', randomBytes(200_000).toString('hex'), { compression: 'STORE', createFolders: false })
    zip.file('[Content_Types].xml', CONTENT_TYPES, { createFolders: false })
    zip.file('_rels/.rels', PACKAGE_RELS, { createFolders: false })
    const file = await zip.generateAsync({ type: 'uint8array' })
    // The central directory declares 200 MB for document.xml, whose bytes lie before the last 64 KB of the file.
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    const central = view.getUint32(file.length - 22 + 16, true)
    expect(new TextDecoder().decode(file.subarray(central + 46, central + 46 + view.getUint16(central + 28, true)))).toBe('word/document.xml')
    view.setUint32(central + 24, 200 * 1024 * 1024, true)
    serve(file)
    for (const mode of ['card', 'focus'] as const) {
      ranges = []
      const shown = await render(docxItem(nextUrl(), file.length), mode)
      expect(ranges).toEqual(['bytes=-65577'])
      expect(shown.textContent).toContain(t('files.viewer.tooLarge'))
    }
  })

  it('shows the first 40 blocks in a card with a note that the rest is in the focus view, and every block in the focus view, keeping the pictures already drawn', async () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => paragraph(`段落 ${i + 1}: ${'段落の文'.repeat(10)}`))
    blocks.splice(1, 0, drawing('rIdP0', '図1'))
    blocks.splice(0, 0, '<w:p><w:hyperlink w:anchor="_Last"><w:r><w:t>最後へ</w:t></w:r></w:hyperlink></w:p>')
    blocks.push('<w:p><w:bookmarkStart w:id="0" w:name="_Last"/><w:r><w:t>最後の節</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>')
    const file = await docxOf(blocks, { photos: ['image1.jpeg'] })
    serve(file)
    const item = docxItem(nextUrl(), file.length)
    const card = await render(item, 'card')
    expect(card.querySelectorAll('.fv-doc p')).toHaveLength(40)
    expect(card.textContent).toContain(t('files.viewer.docxMore'))
    // A link to a place past the head says where the rest is.
    await act(async () => card.querySelector<HTMLElement>('.fv-doc a')!.click())
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: t('files.viewer.docxMore') })

    await act(async () => root.unmount())
    root = createRoot(container)
    const focus = await render(item, 'focus', (box) => box.querySelector('canvas') !== null)
    const picture = focus.querySelector('canvas')!
    await moveTo(picture, 300)
    await settle(() => picture.getAttribute('data-state') === 'drawn', 'the picture to be drawn')
    await settle(() => !focus.textContent!.includes(t('files.viewer.loading')), 'the rest of the document to be mounted')
    const pieces = focus.querySelectorAll('.fv-doc-piece')
    expect(pieces.length).toBeGreaterThan(1)
    expect(focus.querySelectorAll('.fv-doc-piece > p')).toHaveLength(1003)
    expect(focus.querySelector('.fv-doc-piece:last-child p:last-child')?.textContent).toBe('最後の節')
    // The head gave its place to the whole document, with the picture it had drawn in it, not read again.
    expect(focus.querySelector('canvas')).toBe(picture)
    expect(decoded).toHaveLength(1)
  })

  it('shows a picture it cannot decode as unreadable, and asks again for one the preview page stopped on', async () => {
    const file = await docxOf([drawing('rIdP0', '図1'), drawing('rIdP1', '図2')], { photos: ['image1.jpeg', 'image2.jpeg'] })
    serve(file)
    const frame = await render(docxItem(nextUrl(), file.length), 'card')
    place(frame.querySelector('.fv-scroll')!, 0, 420)
    Object.defineProperty(frame.querySelector('.fv-doc')!, 'clientWidth', { value: 400 })
    const [damaged, stopped] = frame.querySelectorAll('canvas')
    place(stopped, 5000, 150)

    decodeFailures.push(new Error('The source image could not be decoded.'))
    await moveTo(damaged, 100)
    await settle(() => frame.querySelector('span.fv-doc-picture') !== null, 'the unreadable picture')
    expect(frame.querySelector('span.fv-doc-picture')!.textContent).toBe(t('files.viewer.imageFailed'))

    // The page stopped once, before it answered; the picture is asked for again and drawn.
    decodeFailures.push(new Error('[asist:files.errors.previewStopped]'))
    await moveTo(stopped, 100)
    await settle(() => stopped.getAttribute('data-state') === 'drawn', 'the picture asked for again')
    expect(decoded).toHaveLength(3)
  })

  it('draws a file saved again while it is shown in its new version from its head, saved at another length or at the same length', async () => {
    const version = (word: string): Promise<Uint8Array> => docxOf([paragraph(`${word}の本文`), drawing('rIdP0', '図1')], { photos: ['image1.jpeg'], store: true })
    const first = await version('初版')
    serve(first)
    const item = docxItem(nextUrl(), first.length)
    const frame = await render(item, 'card')
    place(frame.querySelector('.fv-scroll')!, 0, 420)
    expect(frame.querySelector('.fv-doc p')!.textContent).toBe('初版の本文')

    /** Saves the file again, and lets the picture come near so that the viewer reads the file. */
    const saveAndRead = async (file: Uint8Array): Promise<void> => {
      serve(file)
      const canvas = frame.querySelector('canvas')!
      place(canvas, 3000, 150)
      await act(async () => LayoutIntersectionObserver.update())
      await moveTo(canvas, 100)
    }
    const longer = await version('第二版')
    expect(longer.length).not.toBe(first.length)
    await saveAndRead(longer)
    await settle(() => frame.querySelector('.fv-doc p')?.textContent === '第二版の本文', 'the second version from its head')
    // The second version is drawn alone: its paragraph and its picture's, and nothing of the first.
    expect(frame.querySelectorAll('.fv-doc p')).toHaveLength(2)
    expect(frame.querySelectorAll('.fv-doc canvas')).toHaveLength(1)

    const sameLength = await version('第三版')
    expect(sameLength.length).toBe(longer.length)
    await saveAndRead(sameLength)
    await settle(() => frame.querySelector('.fv-doc p')?.textContent === '第三版の本文', 'the third version, saved at the same length')
    const canvas = frame.querySelector('canvas')!
    await moveTo(canvas, 3000)
    await moveTo(canvas, 100)
    await settle(() => canvas.getAttribute('data-state') === 'drawn', 'the third version\'s picture')
    expect(frame.querySelector('span.fv-doc-picture')).toBeNull()
  })

  it('reads the document again for the focus view after the card failed to read it, rather than keeping the failure', async () => {
    const file = await docxOf([paragraph('調査の結果'), drawing('rIdP0', '図1')], { photos: ['image1.jpeg'] })
    serve(file)
    refuseNext = true
    const item = docxItem(nextUrl(), file.length)
    const card = await render(item, 'card')
    expect(card.querySelector('.fv-note[data-tone="error"]')?.textContent).toContain(t('files.errors.loadFailed', { status: 503 }))
    // The card still holds the document while the focus view opens it.
    const box = document.createElement('div')
    document.body.append(box)
    const focusRoot = createRoot(box)
    try {
      await act(async () => focusRoot.render(<FileViewer item={item} mode="focus" size="focus" />))
      await settle(() => box.querySelector('.fv-doc p') !== null, 'the focus view to show the document')
      expect(box.querySelector('.fv-doc p')!.textContent).toBe('調査の結果')
    } finally {
      await act(async () => focusRoot.unmount())
      box.remove()
    }
  })

  it('follows a link pressed in the focus view before the rest of the document is mounted, once it is', async () => {
    const blocks = Array.from({ length: 100 }, (_, i) => paragraph(`段落 ${i + 1}`))
    blocks.unshift('<w:p><w:hyperlink w:anchor="_Last"><w:r><w:t>最後へ</w:t></w:r></w:hyperlink></w:p>')
    blocks.push('<w:p><w:bookmarkStart w:id="0" w:name="_Last"/><w:r><w:t>最後の節</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>')
    const file = await docxOf(blocks)
    serve(file)
    // The frames that mount the rest of the document wait until the test lets them run.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const frame = await render(docxItem(nextUrl(), file.length), 'focus', (box) => box.querySelector('.fv-doc a') !== null)
    scrollable(container, -500)
    await act(async () => anchorIn(frame, '最後へ').click())
    expect(frame.textContent).toContain(t('files.viewer.loading'))
    expect(useToastStore.getState().toasts).toEqual([])
    expect(container.scrollTop).toBe(0)
    await settle(() => {
      frames.splice(0).forEach((callback) => callback(0))
      return !frame.textContent!.includes(t('files.viewer.loading'))
    }, 'the rest of the document to be mounted')
    expect(frame.querySelector('[id="docx-_Last"]')).not.toBeNull()
    expect(container.scrollTop).toBe(500)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('counts as blocks the paragraphs inside a content control and the rows of a table, and not the marks or empty paragraphs between them', async () => {
    const row = (i: number): string => `<w:tr><w:tc><w:p><w:r><w:t>行 ${i}</w:t></w:r></w:p></w:tc></w:tr>`
    const table = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${Array.from({ length: 30 }, (_, i) => row(i + 1)).join('')}</w:tbl>`
    const controlled = `<w:sdt><w:sdtPr/><w:sdtContent>${Array.from({ length: 30 }, (_, i) => paragraph(`項目 ${i + 1}`)).join('')}</w:sdtContent></w:sdt>`
    const file = await docxOf([controlled, '<w:p/>', '<w:bookmarkStart w:id="1" w:name="x"/>', table])
    serve(file)
    const card = await render(docxItem(nextUrl(), file.length), 'card')
    expect([...card.querySelectorAll('.fv-doc p')].filter((p) => !p.closest('td'))).toHaveLength(30)
    expect(card.querySelectorAll('.fv-doc tr')).toHaveLength(10)
    expect(card.textContent).toContain(t('files.viewer.docxMore'))

    // Forty paragraphs followed by marks and empty paragraphs alone have no rest to point to.
    const marks = '<w:bookmarkStart w:id="2" w:name="y"/><w:bookmarkEnd w:id="2"/><w:p><w:pPr/></w:p><w:p/>'
    const whole = await docxOf([...Array.from({ length: 40 }, (_, i) => paragraph(`段落 ${i + 1}`)), marks, marks])
    serve(whole)
    const shown = await render(docxItem(nextUrl(), whole.length), 'card')
    expect(shown.querySelectorAll('.fv-doc p')).toHaveLength(40)
    expect(shown.textContent).not.toContain(t('files.viewer.docxMore'))
  })

  it('mounts a table too large for one piece as tables of rows, each with its header', { timeout: 30_000 }, async () => {
    const cell = (text: string): string => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
    const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('支店')}${cell('売上')}</w:tr>`
    // About 280 characters of HTML a row, so that 400 rows fill more than two pieces.
    const rows = Array.from({ length: 400 }, (_, i) => `<w:tr>${cell(`支店 ${i + 1} ${'説明'.repeat(100)}`)}${cell(`${(i + 1) * 1000} 円`)}</w:tr>`)
    const file = await docxOf([`<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${header}${rows.join('')}</w:tbl>`])
    serve(file)
    const frame = await render(docxItem(nextUrl(), file.length), 'focus', (box) => box.querySelector('table') !== null && !box.textContent!.includes(t('files.viewer.loading')))
    const pieces = [...frame.querySelectorAll('.fv-doc-piece')]
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.querySelectorAll(':scope > table')).toHaveLength(1)
      expect(piece.querySelector('tr')?.textContent).toBe('支店売上')
    }
    const bodyRows = [...frame.querySelectorAll('tr')].filter((tr) => tr.textContent !== '支店売上')
    expect(bodyRows).toHaveLength(400)
    expect(bodyRows.at(-1)?.textContent).toBe(`支店 400 ${'説明'.repeat(100)}400000 円`)
  })

  it('reads only the parts mammoth reads, and none of the other XML of the file', async () => {
    const glossary = `<w:glossaryDocument ${W}>${'<w:p/>'.repeat(40_000)}</w:glossaryDocument>`
    const file = await docxOf([paragraph('調査の結果')], { photos: ['image1.jpeg'], parts: { 'word/glossary/document.xml': glossary, 'customXml/item1.xml': `<data>${'x'.repeat(100_000)}</data>` } })
    serve(file)
    const item = docxItem(nextUrl(), file.length)
    await render(item, 'card')
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(item, 'focus')
    const unread = [...entryRanges(file)].filter(([name]) => name === 'word/glossary/document.xml' || name === 'customXml/item1.xml').map(([, range]) => range)
    expect(unread).toHaveLength(2)
    const asked = ranges.flatMap((header) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(header)
      return range ? [{ start: Number(range[1]), end: Number(range[2]) + 1 }] : []
    })
    expect(asked.filter((range) => unread.some((entry) => range.start < entry.end && entry.start < range.end))).toEqual([])
  })

  it('reports the version of the file it opened, which a file saved again at the same length changes', async () => {
    const { default: openDocx } = await import('@/preview/methods/docx')
    const file = await docxOf([paragraph('版を確かめる段落')], { store: true })
    serve(file)
    const before = (await openDocx(nextUrl())).version
    serve(file)
    const after = (await openDocx(nextUrl())).version
    expect(before).toBeDefined()
    expect(after).not.toBe(before)
  })

  /** A docx with a table of contents entry, a link to a removed bookmark and a mail link. */
  async function linkedDocx(): Promise<FileItem> {
    const link = (attributes: string, text: string): string => `<w:p><w:hyperlink ${attributes}><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`
    const file = await docxOf(
      [
        link('w:anchor="_Toc1"', 'Findings'),
        link('w:anchor="_Toc9"', 'Removed section'),
        link('r:id="rId1"', 'Write to us'),
        '<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>The findings</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
      ],
      { rels: '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:team@example.com" TargetMode="External"/>' }
    )
    serve(file)
    return docxItem(nextUrl(), file.length)
  }

  /** happy-dom lays nothing out, so a box that scrolls is given its overflow, its sizes and its place here. */
  function scrollable(box: HTMLElement, top: number): void {
    box.style.overflowY = 'auto'
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 400 })
    box.getBoundingClientRect = () => ({ top }) as DOMRect
  }

  const anchorIn = (frame: HTMLElement, text: string): HTMLElement => [...frame.querySelectorAll<HTMLElement>('.fv-doc a')].find((a) => a.textContent === text)!
  const bookmarkAt = (frame: HTMLElement, top: number): void => {
    frame.querySelector<HTMLElement>('.fv-doc [id="docx-_Toc1"]')!.getBoundingClientRect = () => ({ top }) as DOMRect
  }

  it('scrolls the focus view to a place in the document, opens a mail link outside the app, and says so when either cannot be followed', async () => {
    const frame = await render(await linkedDocx(), 'focus')
    // In the focus view the frame shows the whole document, and the view around it scrolls.
    scrollable(container, 100)
    bookmarkAt(frame, 400)

    await act(async () => anchorIn(frame, 'Findings').click())
    expect(container.scrollTop).toBe(300)
    expect(frame.querySelector<HTMLElement>('.fv-scroll')!.scrollTop).toBe(0)
    await act(async () => anchorIn(frame, 'Removed section').click())
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error', title: t('files.viewer.anchorMissing') }])
    expect(openExternal).not.toHaveBeenCalled()

    const refused = errorText('app.links.refused', { url: 'mailto:team@example.com' })
    openExternal.mockRejectedValueOnce(new Error(`Error invoking remote method 'open-external': Error: ${refused}`))
    await act(async () => anchorIn(frame, 'Write to us').click())
    expect(openExternal).toHaveBeenCalledWith('mailto:team@example.com')
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error', title: t('app.links.openFailed'), body: t('app.links.refused', { url: 'mailto:team@example.com' })
    })
  })

  it('scrolls only the frame of a card to a place in the document, leaving the boxes around the card', async () => {
    const frame = await render(await linkedDocx(), 'card')
    const scroller = frame.querySelector<HTMLElement>('.fv-scroll')!
    scrollable(scroller, 100)
    scrollable(container, 0)
    bookmarkAt(frame, 400)
    await act(async () => anchorIn(frame, 'Findings').click())
    expect(scroller.scrollTop).toBe(300)
    expect(container.scrollTop).toBe(0)
  })

  it('shows the reason in red for a file it cannot read', async () => {
    const pptx = readFileSync(resolve(DEMO_DIR, './demo-files/office/slides.pptx'))
    serve(pptx)
    const frame = await render(docxItem(nextUrl(), pptx.length), 'card')
    // The reason is the error of docx-preview, whose wording is the library's.
    expect(frame.querySelector('.fv-note[data-tone="error"]')?.textContent).toMatch(withAnyValue(t('files.viewer.docxFailed', { message: ANY_VALUE })))
  })
})
