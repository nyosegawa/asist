import { useEffect } from 'react'
import { useNoteStore, usePanelStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Empty, More } from '../primitives/Card'
import { relativeTime } from '../primitives/format'
import './notes.css'
import { useT } from '@/i18n'

/**
 * The notes card. It lists the latest notes and opens one in the notes screen when pressed; writing,
 * editing and deleting happen on that screen. A note add_note has just written is marked, because
 * the card comes up to show that it was saved.
 */

const LIMIT: Record<CardContext['size'], number> = { l: 5, m: 4, s: 3, focus: Infinity }

function NotesBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const notes = useNoteStore((s) => s.notes)
  const loaded = useNoteStore((s) => s.loaded)
  const error = useNoteStore((s) => s.error)
  const load = useNoteStore((s) => s.load)
  const setFocused = usePanelStore((s) => s.setFocused)
  const openApp = useViewStore((s) => s.openApp)
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load, spec.updatedAt])

  const focusId = typeof spec.props.focusId === 'string' ? spec.props.focusId : null
  const openWorkspace = (
    <Action leadsTo="screen" onClick={() => openApp({ app: 'notes', noteId: focusId ?? undefined })}>
      {t('notes.card.openWorkspace')}
    </Action>
  )
  // Until the notes have been read the card knows nothing about them, so it does not say there are none.
  if (!loaded)
    return (
      <div className="card nt" data-size={size}>
        <div className="card-hero">
          <h3>{t('notes.card.title')}</h3>
        </div>
        <Empty note={error || undefined}>{error ? t('notes.card.loadFailed') : t('common.loading')}</Empty>
        <Actions>
          {error && <Action onClick={() => void load()}>{t('common.retry')}</Action>}
          {openWorkspace}
        </Actions>
      </div>
    )

  const shown = notes.slice(0, LIMIT[size])
  const rest = notes.length - shown.length
  return (
    <div className="card nt" data-size={size}>
      <div className="card-hero">
        <h3>{t('notes.card.title')}</h3>
        <p>{notes.length ? t('notes.card.count', { count: notes.length }) : t('notes.card.empty')}</p>
      </div>
      <Box title={t('notes.card.list')}>
        {notes.length === 0 ? (
          <Empty note={t('notes.card.emptyNote')}>{t('notes.card.emptyList')}</Empty>
        ) : (
          <ul className="card-rows">
            {shown.map((note) => (
              <li key={note.id} className="card-row nt-item" data-new={note.id === focusId || undefined}>
                <button type="button" className="nt-open" onClick={() => openApp({ app: 'notes', noteId: note.id })}>
                  <span className="card-row-title">{note.title || t('notes.untitled')}</span>
                  {note.excerpt && <span className="nt-excerpt">{note.excerpt}</span>}
                  <span className="card-row-meta">{relativeTime(note.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('notes.card.more')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
      <Actions>{openWorkspace}</Actions>
      {error && (
        <p className="card-missing" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const notesCard: CardDefinition = {
  Body: NotesBody,
  kicker: 'NOTES',
  className: 'nt-card'
}
