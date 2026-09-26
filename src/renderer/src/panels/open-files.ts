import { usePanelStore } from '@/state/stores'

/**
 * Opens a files card from inside the renderer, for a job's artifacts or the entries of a folder. It follows
 * the same shape as the LLM's show_files: the card is placed in the loading state before main is asked for
 * the contents.
 */
export function openFiles(paths: string[], title?: string, selected = 0): void {
  const apply = usePanelStore.getState().apply
  const key = `files:${paths.join('|')}`
  const props: Record<string, unknown> = { paths, ...(title ? { title } : {}), selected }
  apply({ op: 'create', key, type: 'files', slot: 'right', props, state: 'loading' })
  void window.api
    .panelFetch('files', props)
    .then((result) => apply({ op: 'patch', key, props: result.props, state: 'ready', source: result.source }))
    .catch((err: unknown) => apply({ op: 'patch', key, state: 'error', error: err instanceof Error ? err.message : String(err) }))
}
