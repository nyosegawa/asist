import { useEffect, useState } from 'react'
import type { SpeakerOption, TtsEngine } from '@shared/ipc'
import { displayError } from '@/display-error'

export type SpeakerOptions = {
  engine: TtsEngine
  status: 'loading' | 'ready' | 'error'
  options: SpeakerOption[]
  error?: string
}

/** The cleanup disables both the success and the failure path, so the options of another engine never mix in. */
export function requestSpeakerOptions(
  engine: TtsEngine,
  load: (engine: TtsEngine) => Promise<SpeakerOption[]>,
  publish: (state: SpeakerOptions) => void
): () => void {
  let current = true
  publish({ engine, status: 'loading', options: [] })
  void load(engine).then(
    (options) => {
      if (current) publish({ engine, status: 'ready', options })
    },
    (error: unknown) => {
      if (current) publish({ engine, status: 'error', options: [], error: displayError(error) })
    }
  )
  return () => { current = false }
}

export function useSpeakerOptions(open: boolean, engine: TtsEngine): SpeakerOptions {
  const [state, setState] = useState<SpeakerOptions | null>(null)
  useEffect(() => {
    if (!open || engine === 'system') {
      setState(null)
      return
    }
    return requestSpeakerOptions(engine, (selected) => window.api.listSpeakers(selected), setState)
  }, [open, engine])
  // In the render between a change of engine and the start of the effect, the previous engine's
  // options must not be selectable either.
  return state?.engine === engine && open ? state : { engine, status: 'loading', options: [] }
}
