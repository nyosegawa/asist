import JSZip from 'jszip'
import { errorText } from '@shared/i18n/error-text'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import { fontSizeCqw, parsePresentation, parseRels, parseSlide, placeholderFrames, resolveTarget, type PptxFrame, type PptxShape, type PptxSize, type PptxSlide } from './pptx-model'
import './PptxViewer.css'
import { useT } from '@/i18n'

/**
 * PowerPoint (pptx) drawn as slide boxes. The zip is opened, its XML is read (pptx-model), and the shapes are
 * placed by their share of the slide. A font size is a share of the slide width (cqw), so the look holds when
 * the box changes width. A card shows the first slide and the number of slides, while the focus view stacks
 * them all with their numbers.
 */
export interface PptxDeck {
  size: PptxSize
  slides: PptxSlide[]
  /** A path inside the zip mapped to a data URL. The renderer's CSP does not allow blob: in img-src, so data: is used. */
  images: Map<string, string>
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' }

async function readXml(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) throw new Error(errorText('files.errors.entryMissing', { path }))
  return file.async('string')
}
const relsPath = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`
}
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

async function optionalRels(zip: JSZip, path: string): Promise<Map<string, string>> {
  const file = zip.file(relsPath(path))
  return file ? parseRels(await file.async('string')) : new Map()
}

/** The placeholder positions from the slide's layout and master, the layout first. */
async function inheritedFrames(zip: JSZip, slidePath: string, slideRels: Map<string, string>, size: PptxSize): Promise<Map<string, PptxFrame>[]> {
  const layoutTarget = [...slideRels.values()].find((target) => target.includes('slideLayout'))
  if (!layoutTarget) return []
  const layoutPath = resolveTarget(dirOf(slidePath), layoutTarget)
  const layoutFile = zip.file(layoutPath)
  if (!layoutFile) return []
  const frames = [placeholderFrames(await layoutFile.async('string'), size)]
  const masterTarget = [...(await optionalRels(zip, layoutPath)).values()].find((target) => target.includes('slideMaster'))
  const masterFile = masterTarget && zip.file(resolveTarget(dirOf(layoutPath), masterTarget))
  if (masterFile) frames.push(placeholderFrames(await masterFile.async('string'), size))
  return frames
}

export async function parsePptx(bytes: ArrayBuffer): Promise<PptxDeck> {
  const zip = await JSZip.loadAsync(bytes)
  const presentation = parsePresentation(await readXml(zip, 'ppt/presentation.xml'))
  const presentationRels = parseRels(await readXml(zip, 'ppt/_rels/presentation.xml.rels'))
  const images = new Map<string, string>()
  const slides: PptxSlide[] = []
  for (const relId of presentation.slideRelIds) {
    const target = presentationRels.get(relId)
    if (!target) throw new Error(errorText('files.errors.slideRefMissing', { relId }))
    const path = resolveTarget('ppt', target)
    const rels = await optionalRels(zip, path)
    const inherited = await inheritedFrames(zip, path, rels, presentation.size)
    const shapes = parseSlide(await readXml(zip, path), presentation.size, rels, inherited)
    for (const shape of shapes) {
      if (shape.kind !== 'picture') continue
      const imagePath = resolveTarget(dirOf(path), shape.target)
      shape.target = imagePath
      if (images.has(imagePath)) continue
      const file = zip.file(imagePath)
      if (!file) continue
      const ext = imagePath.slice(imagePath.lastIndexOf('.') + 1).toLowerCase()
      images.set(imagePath, `data:${MIME[ext] ?? 'application/octet-stream'};base64,${await file.async('base64')}`)
    }
    slides.push({ path, shapes })
  }
  return { size: presentation.size, slides, images }
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`

function Shape({ shape, deck }: { shape: PptxShape; deck: PptxDeck }): React.JSX.Element | null {
  const style: React.CSSProperties | undefined = shape.frame
    ? { left: percent(shape.frame.x), top: percent(shape.frame.y), width: percent(shape.frame.w), height: percent(shape.frame.h) }
    : undefined
  if (shape.kind === 'picture') {
    const url = deck.images.get(shape.target)
    if (!url) return null
    return <img className="fv-pptx-picture" src={url} alt="" style={style} data-placed={shape.frame ? 'true' : undefined} />
  }
  return (
    <div className="fv-pptx-text" style={style} data-placed={shape.frame ? 'true' : undefined} data-placeholder={shape.placeholder ?? undefined}>
      {shape.paragraphs.map((para, i) => (
        <p
          key={i}
          className="fv-pptx-para"
          data-bullet={para.bullet ? 'true' : undefined}
          style={{ fontSize: `${fontSizeCqw(para.sizePt, deck.size).toFixed(3)}cqw`, fontWeight: para.bold ? 600 : undefined, marginLeft: para.level ? `${para.level * 1.5}em` : undefined }}
        >
          {para.text}
        </p>
      ))}
    </div>
  )
}

function Slide({ slide, deck, number }: { slide: PptxSlide; deck: PptxDeck; number?: number }): React.JSX.Element {
  return (
    <figure className="fv-pptx-figure">
      <div className="fv-pptx-slide" style={{ aspectRatio: `${deck.size.cx} / ${deck.size.cy}` }}>
        {slide.shapes.map((shape, i) => (
          <Shape key={i} shape={shape} deck={deck} />
        ))}
      </div>
      {number !== undefined && <figcaption className="fv-pptx-number">{number}</figcaption>}
    </figure>
  )
}

export const PptxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const parsed = useParsedBytes(item, parsePptx)
  if (parsed.status !== 'ready') {
    return (
      <Frame mode={mode} size={size}>
        {parsed.status === 'loading' ? (
          <p className="fv-note">{t('files.viewer.loading')}</p>
        ) : (
          <p className="fv-note" data-tone="error">
            {t('files.viewer.pptxFailed', { message: parsed.message })}
          </p>
        )}
      </Frame>
    )
  }
  const slides = parsed.value.slides
  if (slides.length === 0) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note">{t('files.viewer.pptxEmpty')}</p>
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size} className="fv-pptx">
      {mode === 'card' ? (
        <>
          <Slide slide={slides[0]} deck={parsed.value} />
          <p className="fv-note">
            {slides.length > 1 ? t('files.viewer.pptxCountMore', { count: slides.length }) : t('files.viewer.pptxCount', { count: slides.length })}
          </p>
        </>
      ) : (
        slides.map((slide, i) => <Slide key={slide.path} slide={slide} deck={parsed.value} number={i + 1} />)
      )}
    </Frame>
  )
}
