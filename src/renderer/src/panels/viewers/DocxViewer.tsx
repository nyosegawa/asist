import { useEffect, useRef, useState } from 'react'
import type { FileItem } from '@shared/files'
import { errorKeyOf } from '@shared/i18n/error-key'
import { cleanDocxHtml, PICTURE_CLASS } from './docx-html'
import { Frame } from './Frame'
import { openPreviewDocument, type PreviewHandle } from './preview-client'
import { TooLargeViewer } from './StubViewer'
import type { Viewer, ViewerProps } from './types'
import { useNearWatch, type NearReport } from './use-near'
import './DocxViewer.css'
import { displayError } from '@/display-error'
import { translate, useT } from '@/i18n'
import { openLink } from '@/open-link'
import type openDocx from '@/preview/methods/docx'
import { useToastStore } from '@/state/stores'

/**
 * Word (docx) drawn as a document. The preview page converts it with mammoth (preview/methods/docx.ts), and the
 * page cleans the HTML (docx-html.ts) and mounts it. A card shows the first blocks of the body; the focus view shows
 * the same first, then mounts the whole document a piece per frame, each piece laid out only near the view. A
 * picture is read and decoded in the preview page once it comes within a screen of the view, and let go of once
 * it leaves. A link to a web page or a mail address opens outside the app, and a link to a place in the document,
 * such as an entry of its table of contents or a footnote, scrolls to that place.
 */

type OpenedDocx = PreviewHandle<typeof openDocx>
type WatchNear = (element: Element, report: NearReport) => () => void

type Shown =
  | { status: 'loading' }
  /** The head is mounted, and the body goes on past it when `more` is set. */
  | { status: 'head'; more: boolean }
  | { status: 'whole' }
  | { status: 'error'; message: string }

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** The preview page stopped before it answered, as when another file took its process down; a new one answers. */
const stopped = (error: unknown): boolean => errorKeyOf(error) === 'files.errors.previewStopped'

/** Asks again once when the preview page stopped before it answered, since the request starts a new one. */
async function askAgainIfStopped<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask()
  } catch (error) {
    if (!stopped(error)) throw error
    return ask()
  }
}

/** The measures of the column a piece is laid out in. */
interface ColumnMeasures {
  width: number
  fontSize: number
  lineHeight: number
}

function columnOf(column: HTMLElement): ColumnMeasures {
  const style = getComputedStyle(column)
  return {
    width: column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    fontSize: parseFloat(style.fontSize),
    lineHeight: parseFloat(style.lineHeight)
  }
}

/** Characters a line gives a whole em, as Japanese, Chinese and Korean take; the others take about half. */
const WIDE = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g

/**
 * The height a piece will take once laid out: the lines its text fills at the column's width, at least one for each
 * block, row and list item, a margin for each block, and three quarters of the column's width for each picture. A
 * piece not laid out yet is given it, so that the scroll bar is near the length of the whole document from the start.
 */
function estimatedHeight(piece: HTMLElement, column: ColumnMeasures): number {
  let lines = 0
  for (const block of piece.children) {
    const text = block.textContent ?? ''
    const wide = text.match(WIDE)?.length ?? 0
    const filled = Math.ceil(((wide + (text.length - wide) * 0.55) * column.fontSize) / column.width)
    lines += Math.max(1, filled, block.querySelectorAll('tr, li').length)
  }
  const pictures = piece.querySelectorAll(`.${PICTURE_CLASS}`).length
  return Math.round(lines * column.lineHeight + piece.children.length * column.fontSize * 0.6 + pictures * column.width * 0.75)
}

/** A piece of the document as nodes of the page, under an element of its own. */
function pieceOf(html: string): HTMLDivElement {
  const piece = document.createElement('div')
  piece.className = 'fv-doc-piece'
  piece.append(cleanDocxHtml(html))
  return piece
}

const picturesIn = (root: ParentNode): HTMLCanvasElement[] => [...root.querySelectorAll<HTMLCanvasElement>(`canvas.${PICTURE_CLASS}`)]

interface Picture {
  near: boolean
  state: 'blank' | 'loading' | 'drawn'
  /** Whether it was asked for again, while near, after the preview page stopped. */
  askedAgain: boolean
  stop(): void
}

/**
 * The pictures of the mounted document. Each canvas is watched; its picture is asked for, at the width of the
 * column in device pixels, when it comes near the view, and given up when it leaves, while the canvas keeps its
 * size so that nothing around it moves.
 *
 * A picture is drawn with a 2D context and given up by shrinking the canvas to nothing, which returns its memory.
 * A bitmaprenderer context given null instead kept about 9 MB for each picture of 1440 x 1080 it had shown, in the
 * renderer and out of reach of the garbage collector (headless Chrome, 2026-10-02).
 */
function documentPictures(docx: OpenedDocx, watchNear: WatchNear, column: HTMLElement) {
  const watched = new Map<HTMLCanvasElement, Picture>()

  function release(canvas: HTMLCanvasElement, picture: Picture): void {
    canvas.width = 0
    canvas.height = 0
    delete canvas.dataset.state
    picture.state = 'blank'
  }

  function forget(canvas: HTMLCanvasElement): void {
    const picture = watched.get(canvas)
    if (!picture) return
    picture.stop()
    watched.delete(canvas)
    if (picture.state === 'drawn') release(canvas, picture)
  }

  async function draw(canvas: HTMLCanvasElement, picture: Picture): Promise<void> {
    picture.state = 'loading'
    try {
      const drawn = await docx.call('picture', { path: canvas.dataset.picture!, width: Math.round(column.clientWidth * devicePixelRatio) })
      if (watched.get(canvas) !== picture || !picture.near) {
        drawn.bitmap.close()
        picture.state = 'blank'
        return
      }
      // The box takes the picture's own width and shape from the style, which outlasts the canvas's own size.
      canvas.style.width = `${drawn.width}px`
      canvas.style.aspectRatio = `${drawn.width} / ${drawn.height}`
      canvas.width = drawn.bitmap.width
      canvas.height = drawn.bitmap.height
      canvas.getContext('2d')!.drawImage(drawn.bitmap, 0, 0)
      drawn.bitmap.close()
      canvas.dataset.state = 'drawn'
      picture.state = 'drawn'
    } catch (error) {
      if (watched.get(canvas) !== picture) return
      picture.state = 'blank'
      // A picture the preview page stopped on is asked for once more while it stays near, and again when it next
      // comes near; so is one read while the file was being saved again, when it next comes near. Any other failure
      // is the picture's own, such as a format the page cannot decode, and is shown as such.
      if (stopped(error) && picture.near && !picture.askedAgain) {
        picture.askedAgain = true
        void draw(canvas, picture)
        return
      }
      if (stopped(error) || errorKeyOf(error) === 'files.errors.changedWhileReading') return
      forget(canvas)
      const failed = document.createElement('span')
      failed.className = PICTURE_CLASS
      failed.dataset.picture = canvas.dataset.picture
      failed.dataset.state = 'failed'
      failed.textContent = translate('files.viewer.imageFailed')
      canvas.replaceWith(failed)
    }
  }

  function watch(canvas: HTMLCanvasElement): void {
    const picture: Picture = { near: false, state: 'blank', askedAgain: false, stop: () => undefined }
    watched.set(canvas, picture)
    picture.stop = watchNear(canvas, (near) => {
      picture.near = near
      if (near && picture.state === 'blank') void draw(canvas, picture)
      if (near) return
      picture.askedAgain = false
      if (picture.state === 'drawn') release(canvas, picture)
    })
  }

  return {
    watchIn(piece: ParentNode): void {
      for (const canvas of picturesIn(piece)) watch(canvas)
    },
    /**
     * Moves the pictures of `from` that `to` holds as well into `to`, in place of its own empty ones, so that a
     * piece taking the place of another keeps the pictures already drawn or found unreadable, and watches the rest
     * of `to`. Both come from one version of the file, so a path names the same picture in both.
     */
    carryOver(from: ParentNode, to: ParentNode): void {
      const byPath = new Map<string, HTMLElement[]>()
      for (const picture of from.querySelectorAll<HTMLElement>(`.${PICTURE_CLASS}`)) {
        byPath.set(picture.dataset.picture!, [...(byPath.get(picture.dataset.picture!) ?? []), picture])
      }
      for (const canvas of picturesIn(to)) {
        const kept = byPath.get(canvas.dataset.picture!)?.shift()
        if (kept) canvas.replaceWith(kept)
        else watch(canvas)
      }
      for (const left of byPath.values()) for (const picture of left) if (picture instanceof HTMLCanvasElement) forget(picture)
    },
    dispose(): void {
      for (const canvas of [...watched.keys()]) forget(canvas)
    }
  }
}

/**
 * The nearest box around the element that scrolls its content, below the page. The frame scrolls in a card,
 * while in the focus view the frame shows the whole document and the view around it scrolls.
 */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

function DocxDocument({ item, mode, onTooLarge }: { item: FileItem; mode: ViewerProps['mode']; onTooLarge: () => void }): React.JSX.Element {
  const t = useT()
  const toast = useToastStore((s) => s.push)
  const watchNear = useNearWatch()
  const docRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState<Shown>({ status: 'loading' })
  /** How many times the file was found saved again while it was shown, each of which draws it anew from its head. */
  const [saves, setSaves] = useState(0)
  // A link followed in the focus view before the rest of the document is mounted is followed once it is.
  const waitingLink = useRef<string | null>(null)
  const tooLarge = useRef(onTooLarge)
  tooLarge.current = onTooLarge
  const { url, sizeBytes, modifiedAt } = item

  useEffect(() => {
    const column = docRef.current!
    setShown({ status: 'loading' })
    if (!url) {
      setShown({ status: 'error', message: translate('files.viewer.urlMissing') })
      return
    }
    const docx = openPreviewDocument<typeof openDocx>('docx', { url, sizeBytes, modifiedAt })
    const pictures = documentPictures(docx, watchNear, column)
    let ended = false
    // Nothing read from the old version may stay beside the new one, the paths of its pictures included, so a file
    // saved again is drawn by a run of its own, from its head, after this one has let everything go.
    const stopListening = docx.onChanged(() => {
      if (ended) return
      ended = true
      setSaves((count) => count + 1)
    })
    const show = async (): Promise<void> => {
      const head = await askAgainIfStopped(() => docx.call('head', undefined))
      if (ended) return
      const headPiece = pieceOf(head.html)
      column.append(headPiece)
      pictures.watchIn(headPiece)
      setShown({ status: 'head', more: head.more })
      if (mode === 'card' || !head.more) return
      const pieces = await askAgainIfStopped(() => docx.call('whole', undefined))
      if (ended) return
      const measures = columnOf(column)
      for (const [index, html] of pieces.entries()) {
        await nextFrame()
        if (ended) return
        const piece = pieceOf(html)
        piece.style.containIntrinsicBlockSize = `auto ${estimatedHeight(piece, measures)}px`
        if (index === 0) {
          pictures.carryOver(headPiece, piece)
          headPiece.replaceWith(piece)
        } else {
          column.append(piece)
          pictures.watchIn(piece)
        }
      }
      setShown({ status: 'whole' })
    }
    show().catch((error: unknown) => {
      if (ended) return
      if (errorKeyOf(error) === 'files.viewer.tooLarge') tooLarge.current()
      else setShown({ status: 'error', message: displayError(error) })
    })
    return () => {
      ended = true
      stopListening()
      pictures.dispose()
      column.replaceChildren()
      docx.release()
    }
  }, [url, sizeBytes, modifiedAt, mode, watchNear, saves])

  const follow = (container: HTMLElement, href: string): void => {
    if (!href.startsWith('#')) return openLink(href)
    const target = container.querySelector<HTMLElement>(`#${CSS.escape(href.slice(1))}`)
    if (!target) {
      const more = shown.status === 'head' && shown.more
      if (more && mode === 'focus') waitingLink.current = href
      else toast({ kind: more ? 'info' : 'error', title: t(more ? 'files.viewer.docxMore' : 'files.viewer.anchorMissing') })
      return
    }
    // scrollIntoView would also scroll the boxes further out, even those that hide their overflow, so only
    // the nearest one that scrolls moves. With none, nothing around the document can scroll.
    const scroller = scrollerOf(target)
    if (scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }

  useEffect(() => {
    const href = waitingLink.current
    if (shown.status !== 'whole' || href === null) return
    waitingLink.current = null
    follow(docRef.current!, href)
  })

  return (
    <>
      {shown.status === 'loading' && <p className="fv-note">{t('files.viewer.loading')}</p>}
      <div
        ref={docRef}
        className="fv-doc fv-docx"
        hidden={shown.status === 'loading'}
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest('a[href]')
          if (!anchor) return
          event.preventDefault()
          follow(event.currentTarget, anchor.getAttribute('href')!)
        }}
      />
      {shown.status === 'head' && shown.more && <p className="fv-note">{t(mode === 'card' ? 'files.viewer.docxMore' : 'files.viewer.loading')}</p>}
      {shown.status === 'error' && (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.docxFailed', { message: shown.message })}
        </p>
      )}
    </>
  )
}

/** The version of the file, so that a file saved again since it was found too large is tried again. */
const versionOf = ({ url, sizeBytes, modifiedAt }: FileItem): string => JSON.stringify([url, sizeBytes, modifiedAt ?? null])

export const DocxViewer: Viewer = (props) => {
  const { item, mode, size } = props
  const [tooLargeVersion, setTooLargeVersion] = useState<string | null>(null)
  if (tooLargeVersion === versionOf(item)) return <TooLargeViewer {...props} />
  return (
    <Frame mode={mode} size={size}>
      <DocxDocument item={item} mode={mode} onTooLarge={() => setTooLargeVersion(versionOf(item))} />
    </Frame>
  )
}
