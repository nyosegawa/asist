import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/i18n'
import { keyForApp } from './key-for-app'
import '@/assets/confirm.css'

/**
 * The notice OpenAI asks apps to show once, after the first sign-in with ChatGPT on a computer: the plan is in
 * use and its usage is managed in ChatGPT. It is drawn like the confirmation sheet with one button, and goes
 * to the end of the body because it opens from the first-run setup as well as from the settings.
 */
export function ChatGptPlanNotice({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (keyForApp(event) !== 'Escape') return
      // The settings close on Escape too, which would take the page that opened the notice away with it.
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="confirm-backdrop is-notice" onClick={onClose}>
      <section
        className="glass confirm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chatgpt-notice-title"
        data-notice="chatgpt-plan"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="chatgpt-notice-title">{t('chatgpt.planNotice.title')}</h2>
        <p className="confirm-body">{t('chatgpt.planNotice.body')}</p>
        <div className="confirm-actions">
          <button ref={closeRef} type="button" className="cal-primary" onClick={onClose}>
            {t('chatgpt.planNotice.dismiss')}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
