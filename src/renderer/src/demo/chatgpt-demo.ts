import type { ApiKeyState } from '@shared/ipc'
import type { ChatGptSignInResult, ChatGptStatus } from '@shared/chatgpt'

/**
 * The sign-in with ChatGPT as the demo's main process holds it. A sign-in waits a moment, as the browser
 * would, and comes back signed in. As in main, a sign-in is first when no account signed in on this computer
 * before or when another account is asked for, and signing out keeps the address for the next sign-in.
 */

/** The address the demo signs in with, and the one "another account" picks. */
export const DEMO_CHATGPT_ACCOUNT = 'you@example.com'
const OTHER_ACCOUNT = 'family@example.com'
const BROWSER_MS = 1200

let current: ChatGptStatus = { signIn: 'signedOut', account: null }
const listeners = new Set<() => void>()

/** Starts a screen of the demo from this sign-in. An address in it counts as an account that signed in before. */
export function setDemoChatGpt(status: ChatGptStatus): void {
  current = status
}

/** The state of the sign-in as AppStatus reports it among the keys. */
export function demoChatGptKey(): ApiKeyState {
  if (current.signIn === 'signedIn') return 'verified'
  return current.signIn === 'unreadable' ? 'unreadable' : 'missing'
}

/** Hears every change of the sign-in, after which main pushes a new AppStatus. */
export function onDemoChatGptChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const change = (next: ChatGptStatus): ChatGptStatus => {
  current = next
  listeners.forEach((listener) => listener())
  return current
}

export const demoChatGptApi = {
  chatgptStatus: async (): Promise<ChatGptStatus> => current,
  chatgptSignIn: async (otherAccount: boolean): Promise<ChatGptSignInResult> => {
    await new Promise((resolve) => setTimeout(resolve, BROWSER_MS))
    const first = otherAccount || current.account === null
    const account = otherAccount ? OTHER_ACCOUNT : (current.account ?? DEMO_CHATGPT_ACCOUNT)
    return { status: change({ signIn: 'signedIn', account }), first }
  },
  chatgptSignOut: async (): Promise<ChatGptStatus> => change({ signIn: 'signedOut', account: current.account }),
  chatgptOpenGuide: async (): Promise<void> => {}
}
