import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { useToastStore } from '@/state/stores'

/**
 * Opens a link that comes from content, such as a document, a memory page or a search result, outside the
 * app. Main refuses a scheme it does not hand to macOS, and macOS may have no app for the link; either
 * failure is told in a toast.
 */
export function openLink(url: string): void {
  void window.api.openExternal(url).catch((error: unknown) =>
    useToastStore.getState().push({ kind: 'error', title: translate('app.links.openFailed'), body: displayError(error) })
  )
}
