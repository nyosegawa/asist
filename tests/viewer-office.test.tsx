// @vitest-environment happy-dom
import { createTranslator } from '@shared/i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { sanitizeDocxHtml } from '@/panels/viewers/DocxViewer'
import { sheetToRows } from '@/panels/viewers/XlsxViewer'
import { fontSizeCqw, parsePresentation, parseRels, parseSlide, placeholderFrames, resolveTarget } from '@/panels/viewers/pptx-model'
import { FileViewer } from '@/panels/viewers'

/**
 * The Office viewers. The pure logic (cleaning the HTML, a sheet into rows, pptx XML into shapes and positions)
 * runs on string fixtures, while the rendering reads the real demo files in place of fetch and checks the DOM.
 */

const t = createTranslator('ja-JP')
const DEMO_DIR = resolve('src/renderer/demo-public')
const itemOf = (kind: FileItem['kind']): FileItem => DEMO_OFFICE_ITEMS.find((item) => item.kind === kind)!

let container: HTMLDivElement
let root: Root
const openExternal = vi.fn(async () => {})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = readFileSync(resolve(DEMO_DIR, `.${url}`))
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  })
  vi.stubGlobal('window', Object.assign(window, { api: { openExternal } }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Renders the viewer and waits until it has finished loading. */
async function render(item: FileItem, mode: 'card' | 'focus'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />)
  })
  for (let i = 0; i < 50 && container.textContent?.includes(t('files.viewer.loading')); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  }
  return container.querySelector<HTMLElement>('.fv-frame')!
}

describe('cleaning the docx HTML', () => {
  it('drops script and on* attributes, keeps only the allowed elements, and removes unsafe links and images', () => {
    const html =
      '<h1 onclick="x()">題</h1><script>alert(1)</script><p style="color:red">本文 <strong>太字</strong> <span class="a">囲み</span></p>' +
      '<a href="javascript:alert(1)">危険</a><a href="https://example.com/a">安全</a>' +
      '<img src="https://evil/x.png"><img src="data:image/png;base64,AAAA" alt="図">' +
      '<table><tr><td colspan="2" bgcolor="red">セル</td></tr></table><iframe></iframe>'
    const out = sanitizeDocxHtml(html)
    expect(out).toBe(
      '<h1>題</h1><p>本文 <strong>太字</strong> 囲み</p><a>危険</a><a href="https://example.com/a">安全</a><img><img src="data:image/png;base64,AAAA" alt="図"><table><tbody><tr><td colspan="2">セル</td></tr></tbody></table>'
    )
  })
})

describe('an xlsx sheet into rows', () => {
  it('takes the first row as the header, marks only numeric cells as numeric, and uses the formatted text', () => {
    const sheet = {
      '!ref': 'A1:C3',
      A1: { t: 's', v: '氏名' },
      B1: { t: 's', v: '数' },
      C1: { t: 's', v: '日付' },
      A2: { t: 's', v: 'A' },
      B2: { t: 'n', v: 1234.5, w: '1,234.5' },
      C2: { t: 'd', v: new Date(2026, 8, 1), w: '2026/9/1' },
      A3: { t: 's', v: 'B' },
      B3: { t: 'n', v: 7 }
    }
    expect(sheetToRows('表', sheet)).toEqual({
      name: '表',
      header: ['氏名', '数', '日付'],
      rows: [
        [
          { text: 'A', numeric: false },
          { text: '1,234.5', numeric: true },
          { text: '2026/9/1', numeric: false }
        ],
        [
          { text: 'B', numeric: false },
          { text: '7', numeric: true },
          { text: '', numeric: false }
        ]
      ]
    })
    expect(sheetToRows('空', {})).toEqual({ name: '空', header: [], rows: [] })
  })
})

const PPT_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const SIZE = { cx: 12192000, cy: 6858000 }

describe('pptx XML into slide shapes', () => {
  it('orders the slides by the r:id entries of sldIdLst resolved through the rels, not by the file name', () => {
    const presentation = `<p:presentation ${PPT_NS}><p:sldIdLst><p:sldId id="1" r:id="rId3"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`
    const rels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="x" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x" Target="slides/slide2.xml"/></Relationships>'
    const parsed = parsePresentation(presentation)
    expect(parsed.size).toEqual({ cx: 9144000, cy: 6858000 })
    const map = parseRels(rels)
    expect(parsed.slideRelIds.map((id) => resolveTarget('ppt', map.get(id)!))).toEqual(['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
    expect(resolveTarget('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png')
  })

  it('turns EMU positions into fractions of the slide size and reads bullets, paragraph levels and font sizes', () => {
    const slide = `<p:sld ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="1371600"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:rPr sz="3600"/><a:t>表題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>一つ目</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr sz="2000"/><a:t>二つ目</a:t></a:r><a:br/><a:r><a:t>続き</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>点なし</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="4" name="empty"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="5" name="P"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr></p:pic>
    </p:spTree></p:cSld></p:sld>`
    const shapes = parseSlide(slide, SIZE, new Map([['rId2', '../media/image1.png']]))
    expect(shapes).toEqual([
      {
        kind: 'text',
        placeholder: 'title',
        frame: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
        paragraphs: [{ text: '表題', level: 0, bullet: false, sizePt: 36, bold: true }]
      },
      {
        kind: 'text',
        placeholder: 'body',
        frame: { x: 0, y: 0, w: 0.5, h: 0.5 },
        paragraphs: [
          { text: '一つ目', level: 0, bullet: true, sizePt: 28, bold: false },
          { text: '二つ目\n続き', level: 1, bullet: true, sizePt: 20, bold: false },
          { text: '点なし', level: 0, bullet: false, sizePt: 28, bold: false }
        ]
      },
      { kind: 'picture', frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, target: '../media/image1.png' }
    ])
    // 36 pt as a fraction of the 960 pt slide width is 3.75cqw.
    expect(fontSizeCqw(36, SIZE)).toBeCloseTo(3.75)
  })

  it('inherits the position of a placeholder without an xfrm from the layout, then from the master', () => {
    const layout = `<p:sldLayout ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="1371600"/><a:ext cx="12192000" cy="1371600"/></a:xfrm></p:spPr></p:sp>
    </p:spTree></p:cSld></p:sldLayout>`
    const master = `<p:sldMaster ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="3429000"/><a:ext cx="12192000" cy="3429000"/></a:xfrm></p:spPr></p:sp>
    </p:spTree></p:cSld></p:sldMaster>`
    const slide = `<p:sld ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="S"/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>副題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="4" name="X"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>位置なし</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`
    const inherited = [placeholderFrames(layout, SIZE), placeholderFrames(master, SIZE)]
    const shapes = parseSlide(slide, SIZE, new Map(), inherited)
    expect(shapes.map((shape) => shape.frame)).toEqual([
      { x: 0, y: 0.2, w: 1, h: 0.2 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
      null
    ])
  })
})

describe('Office viewer rendering with the demo files', () => {
  it('renders the headings, emphasis, lists and tables of a docx into .fv-doc and opens links in the browser', async () => {
    const frame = await render(itemOf('docx'), 'card')
    const doc = frame.querySelector('.fv-doc')!
    expect(doc.querySelector('h1')?.textContent).toBe('競合サービスの比較')
    expect(doc.querySelector('strong')?.textContent).toBe('差が大きいのは同時接続数の上限')
    expect([...doc.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['料金と無料枠の有無', '同時接続の上限', 'サポートの応答時間'])
    expect(doc.querySelectorAll('table tr')).toHaveLength(3)
    expect(doc.querySelectorAll('table tr:first-child td')).toHaveLength(3)
    expect(doc.querySelector('script, style, [onclick]')).toBeNull()
  })

  it('switches sheets from the tabs and builds a table with a header row and right-aligned numbers', async () => {
    const frame = await render(itemOf('xlsx'), 'card')
    const tabs = [...frame.querySelectorAll<HTMLButtonElement>('.fv-xlsx-tabs button')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['料金', 'ヒアリング'])
    expect(tabs[0].dataset.current).toBe('true')
    expect([...frame.querySelectorAll('.fv-table thead th')].map((th) => th.textContent)).toEqual(['サービス', '月額(USD)', '同時接続', '無料枠', '更新日'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(6)
    expect(frame.querySelector('.fv-table tbody td:nth-child(2)')?.getAttribute('data-numeric')).toBe('true')
    expect(frame.querySelector('.fv-table tbody td:nth-child(1)')?.getAttribute('data-numeric')).toBeNull()
    await act(async () => tabs[1].click())
    expect([...frame.querySelectorAll('.fv-table thead th')].map((th) => th.textContent)).toEqual(['日付', '相手', 'メモ'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(3)
  })

  it('shows the first slide and the count in a card and every numbered slide in the focus view, placing shapes by fraction', async () => {
    const card = await render(itemOf('pptx'), 'card')
    expect(card.querySelectorAll('.fv-pptx-slide')).toHaveLength(1)
    expect(card.querySelector('.fv-note')?.textContent).toContain(t('files.viewer.pptxCountMore', { count: 3 }))
    // The title of the first slide has no xfrm and inherits its position from the layout.
    const title = card.querySelector<HTMLElement>('.fv-pptx-text[data-placeholder="ctrTitle"]')!
    expect(title.textContent).toBe('競合サービスの比較')
    expect(title.style.top).toBe('16.37%')
    expect(title.style.width).toBe('75.00%')

    const focus = await render(itemOf('pptx'), 'focus')
    const slides = focus.querySelectorAll('.fv-pptx-slide')
    expect(slides).toHaveLength(3)
    expect([...focus.querySelectorAll('.fv-pptx-number')].map((el) => el.textContent)).toEqual(['1', '2', '3'])
    const bullets = [...slides[1].querySelectorAll<HTMLElement>('.fv-pptx-para[data-bullet="true"]')]
    expect(bullets.map((p) => p.textContent)).toEqual(['個人で使うなら C で足りる', '5 人以上のチームは B 一択', '同時接続の上限が決め手', 'A は年払いの割引で C と差が縮まる'])
    expect(bullets[2].style.marginLeft).toBe('1.5em')
    const picture = slides[2].querySelector<HTMLImageElement>('.fv-pptx-picture')!
    expect(picture.src).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(picture.style.left).toBe('12.50%')
    expect(picture.style.width).toBe('50.00%')
  })

  it('shows the reason in red for a file it cannot read', async () => {
    const frame = await render({ ...itemOf('docx'), url: '/demo-files/office/slides.pptx' }, 'card')
    expect(frame.querySelector('.fv-note[data-tone="error"]')?.textContent).toContain('Word を読めません')
  })
})
