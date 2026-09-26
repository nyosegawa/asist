import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ShieldCheck } from 'lucide-react'
import { useT } from '@/i18n'
import { useConfirmStore } from '@/state/confirm'
import '@/assets/confirm.css'

/**
 * How long a newly shown confirmation ignores the controls that answer it. The next request waiting from
 * main appears in the same place the moment the one before it is answered, and without this a double
 * press on that answer would answer the new request unread. A timer rather than the entrance animation
 * sets it, because reduced motion turns the animation off.
 */
export const CONFIRM_ARM_MS = 500

/**
 * The one confirmation sheet of the app. Main asks through it before a mail goes to the trash, before
 * a calendar change and before an operation coming from the Agent, and the screens ask through it
 * before a delete or a discard. It lies over a workspace and over the dock, and it offers the
 * operation to run or cancelling. Escape cancels. A press within CONFIRM_ARM_MS of a request appearing,
 * whether on a button, with Enter on the focused button, on the backdrop or with Escape, does nothing.
 * The answer goes out exactly once, to main or to the screen that asked. The header appears only for a
 * request with a title, the confirming button is drawn as a warning only for an operation that removes
 * something, and a request a conversation turn waits on says that what the user says waits for the
 * answer.
 */
export function ConfirmSheet(): React.JSX.Element {
  const request = useConfirmStore((s) => s.queue[0] ?? null)
  const close = useConfirmStore((s) => s.close)
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  // The request the controls answer: set once it has been on screen for CONFIRM_ARM_MS and cleared as its
  // answer goes out. A ref, because the Escape handler registered when the request appears has to see
  // both changes, and the next request can take the screen before that answer's IPC call returns.
  const answerable = useRef<string | null>(null)

  useEffect(() => {
    if (!request) return
    const id = request.id
    const arm = setTimeout(() => {
      answerable.current = id
    }, CONFIRM_ARM_MS)
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.stopPropagation()
      void answer(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(arm)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  const answer = async (approved: boolean): Promise<void> => {
    if (!request || answerable.current !== request.id) return
    answerable.current = null
    try {
      if (request.resolve) request.resolve(approved)
      else await window.api.confirmResolve(request.id, approved)
    } finally {
      close(request.id)
    }
  }

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key={request.id}
          className="confirm-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={() => void answer(false)}
        >
          <motion.section
            className="glass confirm-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.2, 0.9, 0.25, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            {request.title !== undefined && (
              <header className="confirm-head">
                <span className="confirm-kicker">
                  <ShieldCheck size={13} /> {t('confirm.kicker')}
                </span>
                <span className="confirm-title">{request.title}</span>
              </header>
            )}
            <h2 id="confirm-title">{request.message}</h2>
            {request.detail && <pre className="confirm-detail">{request.detail}</pre>}
            {request.holdsConversation && <p className="confirm-note">{t('confirm.conversationWaits')}</p>}
            <div className="confirm-actions">
              <button ref={cancelRef} type="button" className="cal-btn" onClick={() => void answer(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={request.destructive ? 'confirm-destructive' : 'cal-primary'}
                onClick={() => void answer(true)}
              >
                {request.confirmLabel}
              </button>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
