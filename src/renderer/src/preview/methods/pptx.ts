import { errorKey } from '@shared/i18n/error-key'
import { parsePresentation, parseRels, parseSlide, placeholderFrames, resolveTarget, type PptxFrame, type PptxShape, type PptxSize } from '../pptx-model'
import type { OpenPreviewDocument } from '../serve'
import { openZip, type RangedZip } from '../zip-ranges'

/**
 * A PowerPoint file, read by ranges. Opening it reads the zip's central directory, presentation.xml and its
 * relationships, which give the size and the order of the slides. A slide's XML, its relationships, its layout and
 * its master are read when the viewer asks for the slide, which it does when the slide comes within a screen of
 * the view, and a picture when the viewer asks for it, at the size it is drawn. Nothing of a slide is kept here
 * but the placeholder positions of its layout and master, which the other slides of the layout share.
 */

/** What a viewer needs to lay out a box for every slide before it reads any of them. */
export interface PptxDeck {
  size: PptxSize
  slideCount: number
}

/**
 * A picture as the viewer shows it: a bitmap decoded at the size it is drawn, or an SVG as a data URL, or null for
 * one Chromium does not decode, which is left out of the slide.
 */
export type PptxPicture = { bitmap: ImageBitmap } | { svg: string } | null

const decoder = new TextDecoder()
const readText = async (zip: RangedZip, path: string): Promise<string> => decoder.decode(await zip.read(path))

const relsPath = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`
}
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

async function relsOf(zip: RangedZip, path: string): Promise<Map<string, string>> {
  const rels = relsPath(path)
  return zip.entries.has(rels) ? parseRels(await readText(zip, rels)) : new Map()
}

const targetOf = (rels: Map<string, string>, kind: string): string | undefined => [...rels.values()].find((target) => target.includes(kind))

/**
 * Decodes a picture to fit inside a box of device pixels, as the viewer draws it (object-fit: contain), and never
 * larger than the picture itself. Its own size is known only once it is decoded, and a box of another shape would
 * stretch it, so it is decoded whole first and then scaled. A picture Chromium does not decode gives null: one in a
 * format it does not read, such as the EMF or WMF Office writes for a drawing pasted from another program, and one
 * larger than it decodes at all, as a PNG of 625 megapixels was (headless Chrome 154 on an M5, 2026-10-02).
 */
async function decodeToFit(bytes: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<ImageBitmap | null> {
  let whole: ImageBitmap
  try {
    whole = await createImageBitmap(new Blob([bytes]))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidStateError') return null
    throw error
  }
  const scale = Math.min(1, width / whole.width, height / whole.height)
  if (scale === 1) return whole
  try {
    return await createImageBitmap(whole, {
      resizeWidth: Math.max(1, Math.round(whole.width * scale)),
      resizeHeight: Math.max(1, Math.round(whole.height * scale)),
      resizeQuality: 'high'
    })
  } finally {
    whole.close()
  }
}

/**
 * An SVG picture as a data URL, which the viewer shows in an img. createImageBitmap takes no SVG from bytes, and
 * drawing one through an img here would need blob: images in the preview page's policy, while the app's page
 * already shows data: images and an SVG drawn there stays sharp at any size.
 */
const svgUrl = (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([bytes], { type: 'image/svg+xml' }))
  })

const openPptx = async (url: string) => {
  const zip = await openZip(url)
  const [presentation, presentationRels] = await Promise.all([
    readText(zip, 'ppt/presentation.xml').then(parsePresentation),
    readText(zip, 'ppt/_rels/presentation.xml.rels').then(parseRels)
  ])
  const { size } = presentation
  const slides = presentation.slideRelIds.map((relId) => {
    const target = presentationRels.get(relId)
    if (!target) throw new Error(errorKey('files.errors.slideRefMissing', { relId }))
    return resolveTarget('ppt', target)
  })

  /** The placeholder positions of each layout or master read so far, by its path. */
  const frames = new Map<string, Promise<Map<string, PptxFrame>>>()
  const framesOf = (path: string): Promise<Map<string, PptxFrame>> => {
    let read = frames.get(path)
    if (!read) {
      read = readText(zip, path).then((xml) => placeholderFrames(xml, size))
      frames.set(path, read)
    }
    return read
  }
  /** The placeholder positions a slide inherits from its layout and the layout's master, the layout first. */
  const inherited = new Map<string, Promise<Map<string, PptxFrame>[]>>()
  const inheritedOf = (layout: string): Promise<Map<string, PptxFrame>[]> => {
    let read = inherited.get(layout)
    if (!read) {
      read = (async () => {
        if (!zip.entries.has(layout)) return []
        const masterTarget = targetOf(await relsOf(zip, layout), 'slideMaster')
        const master = masterTarget && resolveTarget(dirOf(layout), masterTarget)
        return Promise.all([layout, ...(master && zip.entries.has(master) ? [master] : [])].map(framesOf))
      })()
      inherited.set(layout, read)
    }
    return read
  }

  return {
    methods: {
      deck: (): PptxDeck => ({ size, slideCount: slides.length }),

      /** The shapes of a slide, a picture's target given as its path inside the zip. */
      slide: async ({ index }: { index: number }): Promise<PptxShape[]> => {
        const path = slides[index]
        // A viewer asks only for the slides the deck had when it opened it, so a slide past the end means the
        // document was opened again, in a frame started after the last one stopped, from a file saved since.
        if (path === undefined) throw new Error(errorKey('files.errors.changedWhileReading'))
        const [xml, rels] = await Promise.all([readText(zip, path), relsOf(zip, path)])
        const layoutTarget = targetOf(rels, 'slideLayout')
        const shapes = parseSlide(xml, size, rels, layoutTarget ? await inheritedOf(resolveTarget(dirOf(path), layoutTarget)) : [])
        // A picture the slide links to outside the file, rather than holds, is not drawn.
        return shapes.flatMap((shape): PptxShape[] => {
          if (shape.kind !== 'picture') return [shape]
          const target = resolveTarget(dirOf(path), shape.target)
          return zip.entries.has(target) ? [{ ...shape, target }] : []
        })
      },

      /** A picture of a slide, fitted inside a box of `width` × `height` device pixels. */
      picture: async ({ path, width, height }: { path: string; width: number; height: number }): Promise<PptxPicture> => {
        const bytes = await zip.read(path)
        if (path.toLowerCase().endsWith('.svg')) return { svg: await svgUrl(bytes) }
        const bitmap = await decodeToFit(bytes, width, height)
        return bitmap && { bitmap }
      }
    }
  }
}

export default openPptx satisfies OpenPreviewDocument
