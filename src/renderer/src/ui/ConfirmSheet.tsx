import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ShieldCheck } from 'lucide-react'
import { useT } from '@/i18n'
import { useConfirmStore } from '@/state/confirm'
import '@/assets/confirm.css'

/**
 * The one confirmation sheet of the app. Main asks through it before a mail goes to the trash, before
 * a calendar change and before an operation coming from the Agent, and the screens ask through it
 * before a delete or a discard. It lies over a workspace and over the dock, and it offers the
 * operation to run or cancelling. Escape cancels. The answer goes out exactly once, to main or to the
 * screen that asked. The header appears only for a request with a title, and the confirming button is
 * drawn as a warning only for an operation that removes something.
 */
export function ConfirmSheet(): React.JSX.Element {
  const request = useConfirmStore((s) => s.request)
  const close = useConfirmStore((s) => s.close)
  const t = useT()
  const [answering, setAnswering] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setAnswering(false)
    if (!request) return
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.stopPropagation()
      void answer(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  const answer = async (approved: boolean): Promise<void> => {
    if (!request || answering) return
    setAnswering(true)
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
            <div className="confirm-actions">
              <button ref={cancelRef} type="button" className="cal-btn" disabled={answering} onClick={() => void answer(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={request.destructive ? 'confirm-destructive' : 'cal-primary'}
                disabled={answering}
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
