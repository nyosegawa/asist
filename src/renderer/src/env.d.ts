/// <reference types="vite/client" />

import type { RendererApi } from '@shared/ipc'

declare global {
  /** Values that the build embeds from .env. */
  interface ImportMetaEnv {
    readonly RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY?: string
  }
  interface Window {
    api: RendererApi
  }
}

export {}
