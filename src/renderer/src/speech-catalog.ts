import type { SpeechCatalog } from '@shared/speech-catalog'

let loaded: SpeechCatalog | null = null

/**
 * Reads the files of the local speech models from the main process, which has them from the bundled speech. They
 * never change while the app runs, so they are read once before anything is drawn, and every screen reads them
 * synchronously afterwards.
 */
export async function loadSpeechCatalog(): Promise<void> {
  loaded ??= await window.api.getSpeechCatalog()
}

/** The files of the local speech models, as the catalog of the bundled speech pins them. */
export function speechCatalog(): SpeechCatalog {
  if (!loaded) throw new Error('the speech catalog is read before it is loaded')
  return loaded
}
