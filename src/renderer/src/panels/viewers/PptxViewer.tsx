import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FileItem } from '@shared/files'
import { errorKeyOf } from '@shared/i18n/error-key'
import type openPptx from '@/preview/methods/pptx'
import type { PptxDeck } from '@/preview/methods/pptx'
import type { PptxFrame, PptxShape, PptxSize } from '@/preview/pptx-model'
import { Frame } from './Frame'
import { openPreviewDocument, type PreviewHandle } from './preview-client'
import type { Viewer } from './types'
import { useNear } from './use-near'
import './PptxViewer.css'
import { displayError } from '@/display-error'
import { translate, useT } from '@/i18n'

/**
 * PowerPoint (pptx) drawn as slide boxes. The preview page reads the file by ranges and parses it
 * (preview/methods/pptx.ts). Here every slide gets a box of the slide's shape, and a slide's shapes are read and
 * drawn only while the box is within a screen of the view. The shapes are placed by their share of the slide, and a
 * font size is a share of the slide width (cqw), so the look holds when the box changes width. A picture is decoded
 * in the preview page at the size it is drawn and shown on a canvas, which lets go of it when its slide leaves. A
 * card shows the first slide and the number of slides, while the focus view stacks them all with their numbers. A
 * file saved again while it is shown is opened anew and shown as it is now.
 */

type PptxHandle = PreviewHandle<typeof openPptx>

type Opened = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: PptxDeck; handle: PptxHandle }

const STOPPED = 'files.errors.previewStopped'

/**
 * Makes a request once more when the preview frame stopped before it answered, as it does when another viewer's
 * file takes the frame out of memory; the client starts a new frame for the second request. A second stop is
 * shown, so that a file that stops the frame itself is not read again and again.
 */
async function askTwice<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask()
  } catch (error) {
    if (errorKeyOf(error) !== STOPPED) throw error
    return ask()
  }
}

/** Opens the file in the preview page, where the card and the focus view of one file share its document. */
function useDeck({ url, sizeBytes, modifiedAt }: FileItem): Opened {
  const [opened, setOpened] = useState<Opened>({ status: 'loading' })
  /** How many times the file was found saved again while it was shown, each of which opens it anew. */
  const [saves, setSaves] = useState(0)
  useEffect(() => {
    if (!url) {
      setOpened({ status: 'error', message: translate('files.viewer.urlMissing') })
      return
    }
    setOpened({ status: 'loading' })
    const handle = openPreviewDocument<typeof openPptx>('pptx', { url, sizeBytes, modifiedAt })
    let current = true
    const stopListening = handle.onChanged(() => {
      if (!current) return
      current = false
      setOpened({ status: 'loading' })
      setSaves((count) => count + 1)
    })
    askTwice(() => handle.call('deck', undefined)).then(
      (deck) => current && setOpened({ status: 'ready', deck, handle }),
      (error) => current && setOpened({ status: 'error', message: displayError(error) })
    )
    return () => {
      current = false
      stopListening()
      handle.release()
    }
  }, [url, sizeBytes, modifiedAt, saves])
  return opened
}

/**
 * The window's device pixel ratio, kept up to date as the window moves to a screen of another density or the page
 * is zoomed. A query on the ratio of the moment changes once that ratio no longer holds, so each change watches
 * the next ratio.
 */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => devicePixelRatio)
  useEffect(() => {
    let query: MediaQueryList | null = null
    const watch = (): void => {
      setRatio(devicePixelRatio)
      query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
      query.addEventListener('change', watch, { once: true })
    }
    watch()
    return () => query?.removeEventListener('change', watch)
  }, [])
  return ratio
}

/**
 * The width of the box in CSS pixels as it is laid out, which a transform, such as the focus view's opening, leaves
 * alone. It is kept up to date while `watching`, and stays as it was last measured otherwise.
 */
function useLaidOutWidth(ref: RefObject<HTMLElement | null>, watching: boolean): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !watching) return
    const measure = (): void => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, watching])
  return width
}

/** Turns a shape's font size from pt into a share of the slide width (cqw). The slide is cx EMU wide, which is cx / 12700 pt. */
export const fontSizeCqw = (sizePt: number, size: PptxSize): number => (sizePt / (size.cx / 12700)) * 100

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`
const placed = (frame: PptxFrame): React.CSSProperties => ({ left: percent(frame.x), top: percent(frame.y), width: percent(frame.w), height: percent(frame.h) })

/** Where a picture without a position of its own is drawn: fitted inside the whole slide. */
const WHOLE_SLIDE: PptxFrame = { x: 0, y: 0, w: 1, h: 1 }

function TextShape({ shape, size }: { shape: Extract<PptxShape, { kind: 'text' }>; size: PptxSize }): React.JSX.Element {
  return (
    <div
      className="fv-pptx-text"
      style={shape.frame ? placed(shape.frame) : undefined}
      data-placed={shape.frame ? 'true' : undefined}
      data-placeholder={shape.placeholder ?? undefined}
    >
      {shape.paragraphs.map((para, i) => (
        <p
          key={i}
          className="fv-pptx-para"
          data-bullet={para.bullet ? 'true' : undefined}
          style={{ fontSize: `${fontSizeCqw(para.sizePt, size).toFixed(3)}cqw`, fontWeight: para.bold ? 600 : undefined, marginLeft: para.level ? `${para.level * 1.5}em` : undefined }}
        >
          {para.text}
        </p>
      ))}
    </div>
  )
}

/**
 * A picture asked of the preview page at the size its box takes on the screen, in device pixels. A bitmap goes on
 * a canvas, which shows it without a copy and lets go of it when the picture is taken off the slide; a bitmap that
 * arrives after that is closed at once. An SVG goes in an img, and a picture Chromium does not decode is left out.
 */
function Picture({
  shape,
  slide,
  ratio,
  handle,
  onError
}: {
  shape: Extract<PptxShape, { kind: 'picture' }>
  slide: { width: number; height: number }
  ratio: number
  handle: PptxHandle
  onError: (message: string) => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [undecodable, setUndecodable] = useState(false)
  const frame = shape.frame ?? WHOLE_SLIDE
  const width = Math.round(slide.width * frame.w * ratio)
  const height = Math.round(slide.height * frame.h * ratio)
  // The canvas lets go of its bitmap only when the picture leaves, so that a picture asked for again at another size
  // stays on the screen until the new bitmap takes its place.
  useEffect(() => {
    const canvas = ref.current
    return () => canvas?.getContext('bitmaprenderer')?.transferFromImageBitmap(null)
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || width < 1 || height < 1) return
    let current = true
    askTwice(() => handle.call('picture', { path: shape.target, width, height })).then(
      (picture) => {
        if (!current) {
          if (picture && 'bitmap' in picture) picture.bitmap.close()
          return
        }
        if (!picture) setUndecodable(true)
        else if ('svg' in picture) setSvg(picture.svg)
        else {
          canvas.width = picture.bitmap.width
          canvas.height = picture.bitmap.height
          canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(picture.bitmap)
        }
      },
      (error) => current && onError(displayError(error))
    )
    return () => {
      current = false
    }
  }, [handle, shape.target, width, height, onError])
  if (undecodable) return null
  if (svg !== null) return <img className="fv-pptx-picture" src={svg} alt="" style={placed(frame)} data-placed="true" />
  return <canvas ref={ref} className="fv-pptx-picture" style={placed(frame)} data-placed="true" />
}

/** Why a slide or one of its pictures could not be read, and whether it was the preview frame that stopped. */
interface Failure {
  message: string
  stopped: boolean
}

const failureOf = (error: unknown): Failure => ({ message: displayError(error), stopped: errorKeyOf(error) === STOPPED })

function Slide({ index, deck, handle, ratio, number }: { index: number; deck: PptxDeck; handle: PptxHandle; ratio: number; number?: number }): React.JSX.Element {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const near = useNear(box)
  // Only a slide near the view draws pictures, which need its width; measuring every slide of a long deck as the
  // focus view opens would render each of them twice.
  const width = useLaidOutWidth(box, near)
  const [shapes, setShapes] = useState<PptxShape[] | null>(null)
  const [failed, setFailed] = useState<Failure | null>(null)
  const [pictureFailed, setPictureFailed] = useState<string | null>(null)
  // The shapes of a slide are a few kilobytes, so a slide read once keeps them, and only its pictures go when it
  // leaves; they are asked for again, and their errors cleared, when it comes back. A slide that failed is read again
  // then only if the preview frame stopped, since a damaged part fails the same way each time.
  useEffect(() => {
    if (!near) {
      setPictureFailed(null)
      if (failed?.stopped) setFailed(null)
      return
    }
    if (shapes || failed) return
    let current = true
    askTwice(() => handle.call('slide', { index })).then(
      (read) => current && setShapes(read),
      (error) => current && setFailed(failureOf(error))
    )
    return () => {
      current = false
    }
  }, [near, shapes, failed, handle, index])
  const { cx, cy } = deck.size
  const slide = { width, height: (width * cy) / cx }
  return (
    <figure className="fv-pptx-figure">
      <div ref={box} className="fv-pptx-slide" style={{ aspectRatio: `${cx} / ${cy}` }}>
        {near &&
          shapes?.map((shape, i) =>
            shape.kind === 'picture' ? (
              <Picture key={i} shape={shape} slide={slide} ratio={ratio} handle={handle} onError={setPictureFailed} />
            ) : (
              <TextShape key={i} shape={shape} size={deck.size} />
            )
          )}
      </div>
      {failed !== null && (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.pptxFailed', { message: failed.message })}
        </p>
      )}
      {pictureFailed !== null && (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.pptxPictureFailed', { message: pictureFailed })}
        </p>
      )}
      {number !== undefined && <figcaption className="fv-pptx-number">{number}</figcaption>}
    </figure>
  )
}

export const PptxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const opened = useDeck(item)
  const ratio = useDevicePixelRatio()
  if (opened.status !== 'ready') {
    return (
      <Frame mode={mode} size={size}>
        {opened.status === 'loading' ? (
          <p className="fv-note">{t('files.viewer.loading')}</p>
        ) : (
          <p className="fv-note" data-tone="error">
            {t('files.viewer.pptxFailed', { message: opened.message })}
          </p>
        )}
      </Frame>
    )
  }
  const { deck, handle } = opened
  if (deck.slideCount === 0) {
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
          <Slide index={0} deck={deck} handle={handle} ratio={ratio} />
          <p className="fv-note">
            {deck.slideCount > 1 ? t('files.viewer.pptxCountMore', { count: deck.slideCount }) : t('files.viewer.pptxCount', { count: deck.slideCount })}
          </p>
        </>
      ) : (
        Array.from({ length: deck.slideCount }, (_, i) => <Slide key={i} index={i} deck={deck} handle={handle} ratio={ratio} number={i + 1} />)
      )}
    </Frame>
  )
}
