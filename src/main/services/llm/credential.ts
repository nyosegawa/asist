/** What authenticates a provider's requests, which every adapter is handed with each call. */
export interface ProviderCredential {
  /**
   * What stands for the credential when main remembers that it was verified: the key itself, or the sign-in's
   * registration and account, since its access token changes every hour.
   */
  identity: string
  /** The bearer value for the next request. */
  token(): Promise<string>
  /** Tells the credential that the API refused `token`, so that the next request does not send it again. */
  refused(token: string): void
}

/** An API key, which stays as it is until the user replaces it. */
export const apiKeyCredential = (key: string): ProviderCredential => ({ identity: key, token: () => Promise.resolve(key), refused: () => {} })
