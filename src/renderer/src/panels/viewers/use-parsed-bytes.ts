import { useEffect, useState } from 'react'
import type { FileItem } from '@shared/files'
import { errorText } from '@shared/i18n/error-text'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'

/**
 * Shared loading for the kinds that arrive as a URL (docx / xlsx / pptx): item.url is fetched into an
 * ArrayBuffer and handed to parse. The URL is asist-file:// in the app and a static path in the demo, and
 * fetch reads both. parse has to be a function defined at module level, because a new function on every
 * render loads the file again.
 */
export type Parsed<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

export function useParsedBytes<T>(item: FileItem, parse: (bytes: ArrayBuffer) => Promise<T>): Parsed<T> {
  const [state, setState] = useState<Parsed<T>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    const url = item.url
    if (!url) {
      setState({ status: 'error', message: translate('files.viewer.urlMissing') })
      return
    }
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(errorText('files.errors.loadFailed', { status: response.status }))
        const value = await parse(await response.arrayBuffer())
        if (!cancelled) setState({ status: 'ready', value })
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: displayError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.url, parse])
  return state
}
