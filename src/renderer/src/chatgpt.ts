import { useCallback, useEffect, useRef, useState } from 'react'
import { CHATGPT_USAGE_URL, type ChatGptStatus } from '@shared/chatgpt'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { useStatusStore, type Toast } from '@/state/stores'

/** Opens ChatGPT's usage settings, where the user sees what ASIST used of the plan and caps its share. */
export function openChatGptUsage(): void {
  void window.api.openExternal(CHATGPT_USAGE_URL)
}

/** The action OpenAI asks apps to lead with when a request fails on the plan's usage. */
export function manageUsageAction(): NonNullable<Toast['action']> {
  return { label: translate('chatgpt.plan.manageUsage'), run: openChatGptUsage }
}

export interface ChatGptSignIn {
  /** Null until main has answered, and while the screen is not active. */
  status: ChatGptStatus | null
  /** A sign-in this screen started waits for the browser. */
  signingIn: boolean
  /** A sign-out is under way. */
  signingOut: boolean
  error: string
  /** The first sign-in on this computer has just completed, and the notice that the plan is in use is open. */
  noticeOpen: boolean
  closeNotice: () => void
  /** Resolves true once main has signed in and checked the sign-in, and false when it failed or a later press replaced it. */
  signIn: (otherAccount: boolean) => Promise<boolean>
  signOut: () => void
}

/**
 * The sign-in with ChatGPT as one screen shows it. Main holds the sign-in; this reads it while `active` and
 * again whenever main reports another state of it, as after a session ended.
 */
export function useChatGptSignIn(active: boolean): ChatGptSignIn {
  const keyState = useStatusStore((state) => state.status?.llmKeys.chatgpt)
  const [status, setStatus] = useState<ChatGptStatus | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  const [noticeOpen, setNoticeOpen] = useState(false)
  const attempt = useRef(0)
  const reads = useRef(0)
  const closeNotice = useCallback(() => setNoticeOpen(false), [])

  const reload = (): void => {
    const read = ++reads.current
    void window.api
      .chatgptStatus()
      .then((next) => read === reads.current && setStatus(next))
      .catch((err: unknown) => read === reads.current && setError(displayError(err)))
  }
  useEffect(() => {
    if (active) reload()
  }, [active, keyState])

  // Pressing again while the browser is open starts over, since that tab may have been closed; main ends the
  // earlier sign-in, whose failure is then not shown.
  const signIn = async (otherAccount: boolean): Promise<boolean> => {
    const mine = ++attempt.current
    setSigningIn(true)
    setError('')
    try {
      const result = await window.api.chatgptSignIn(otherAccount)
      if (mine !== attempt.current) return false
      ++reads.current
      setStatus(result.status)
      if (result.first) setNoticeOpen(true)
      return true
    } catch (err) {
      if (mine === attempt.current) setError(displayError(err))
      return false
    } finally {
      if (mine === attempt.current) setSigningIn(false)
    }
  }

  // A sign-out ends a sign-in still waiting for the browser, so that one's failure is not shown either. A
  // revocation OpenAI did not confirm has still signed out here, so its message is shown with the state read again.
  const signOut = (): void => {
    ++attempt.current
    setSigningIn(false)
    setSigningOut(true)
    setError('')
    void window.api
      .chatgptSignOut()
      .then((next) => {
        ++reads.current
        setStatus(next)
      })
      .catch((err: unknown) => {
        setError(displayError(err))
        reload()
      })
      .finally(() => setSigningOut(false))
  }

  return { status: active ? status : null, signingIn, signingOut, error, noticeOpen, closeNotice, signIn, signOut }
}
