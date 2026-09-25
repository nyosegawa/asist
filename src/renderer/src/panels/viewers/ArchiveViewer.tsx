import { Folder } from 'lucide-react'
import JSZip from 'jszip'
import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/files'
import { archiveTotals, flattenArchive, type ArchiveEntry, type ArchiveRow } from './archive'
import { Frame } from './Frame'
import type { Viewer } from './types'
import './ArchiveViewer.css'
import { displayError } from '@/display-error'
import { translate, useT } from '@/i18n'

/**
 * The listing of a zip. The bytes are fetched, jszip reads the entries, and the folder tree is drawn with the
 * same rows as DirectoryViewer. An entry cannot be opened, because nothing is extracted. A row is about 50px
 * tall, so eight rows at l would hide the note under the blur at the bottom of the Frame. jszip cannot read a
 * password-protected zip, and a broken zip fails the same way; both end in the red note.
 */
const LIMIT = { l: 7, m: 5, s: 3, focus: Infinity } as const

type Listing = { state: 'loading' } | { state: 'ready'; rows: ArchiveRow[] } | { state: 'error'; message: string }

/** The compressed size, which jszip does not expose: it lives only on JSZipObject's _data, a CompressedObject. */
interface JSZipObjectWithData extends JSZip.JSZipObject {
  _data?: { compressedSize: number; uncompressedSize: number }
}

export async function listZip(bytes: ArrayBuffer): Promise<ArchiveEntry[]> {
  const zip = await JSZip.loadAsync(bytes)
  return Object.values(zip.files).map((file) => {
    const data = (file as JSZipObjectWithData)._data
    return { path: file.name, dir: file.dir, size: data?.uncompressedSize ?? 0, compressedSize: data?.compressedSize ?? 0 }
  })
}

function describe(error: unknown): string {
  const message = displayError(error)
  // jszip reports a password-protected zip as "encrypted"; without the check it would read as a broken file.
  if (/encrypted/i.test(message)) return translate('files.viewer.zipEncrypted')
  return translate('files.viewer.zipFailed', { message })
}

function useListing(url: string | undefined): Listing {
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  useEffect(() => {
    if (!url) {
      setListing({ state: 'error', message: translate('files.viewer.zipLoadFailed') })
      return
    }
    let cancelled = false
    setListing({ state: 'loading' })
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const rows = flattenArchive(await listZip(await response.arrayBuffer()))
        if (!cancelled) setListing({ state: 'ready', rows })
      } catch (error) {
        if (!cancelled) setListing({ state: 'error', message: describe(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])
  return listing
}

export const ArchiveViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const listing = useListing(item.url)
  if (listing.state === 'loading') {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note">{t('files.viewer.loading')}</p>
      </Frame>
    )
  }
  if (listing.state === 'error') {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {listing.message}
        </p>
      </Frame>
    )
  }
  const rows = listing.rows
  const shown = rows.slice(0, LIMIT[size])
  const rest = rows.length - shown.length
  const totals = archiveTotals(rows)
  return (
    <Frame mode={mode} size={size}>
      {rows.length === 0 ? (
        <p className="fv-note">{t('files.viewer.emptyZip')}</p>
      ) : (
        <ul className="card-rows">
          {shown.map((row) => (
            <li key={row.path} className="card-row fv-entry fv-archive-row" style={{ '--fv-archive-depth': row.depth } as React.CSSProperties} title={row.path}>
              <div className="card-row-main">
                <span className="card-row-title">
                  {row.dir && <Folder size={12} className="fv-entry-icon" aria-hidden />}
                  {row.name}
                </span>
                <span className="card-row-meta">
                  {row.dir
                    ? t('files.entries', { count: row.children })
                    : t('files.viewer.zipEntry', { size: formatBytes(row.size), compressed: formatBytes(row.compressedSize) })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="fv-note">
        {rest > 0 && `${t('files.viewer.moreEntries', { count: rest })} · `}
        {t('files.viewer.zipTotals', {
          files: totals.files,
          size: formatBytes(totals.size),
          compressed: formatBytes(totals.compressedSize)
        })}
      </p>
    </Frame>
  )
}
