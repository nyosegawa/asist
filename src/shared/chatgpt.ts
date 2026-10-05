/** Where ChatGPT shows how much of the plan each app has used, and where the user caps each app's share. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export interface ChatGptStatus {
  /** `unreadable`: a sign-in is saved, but another build encrypted it, so this one cannot read it. */
  signIn: 'signedIn' | 'signedOut' | 'unreadable'
  /**
   * The address of the account signed in, or, when signed out, of the account the next sign-in returns to.
   * Null before the first sign-in on this computer and after a switch to another account began.
   */
  account: string | null
}

export interface ChatGptSignInResult {
  status: ChatGptStatus
  /** The first sign-in on this computer, after which OpenAI asks apps to say once that the plan is in use. */
  first: boolean
}

/**
 * The errors OpenAI returns for the ChatGPT plan, by the code its Responses API puts on them. Neither is
 * worth repeating the request: the limit lifts only when its period resets, and an account that is not
 * eligible stays so.
 */
export const CHATGPT_USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded'
export const CHATGPT_NOT_ELIGIBLE = 'subscription_sharing_user_not_eligible'

/** The code ASIST puts on a failure that only signing in with ChatGPT again mends. */
export const CHATGPT_SIGN_IN = 'chatgpt_sign_in'
