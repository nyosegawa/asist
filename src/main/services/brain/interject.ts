import { SegmentAssembler } from '@shared/segmenter'
import { conversationLocale } from '../conversation-locale'
import { conversationOwner, currentSpeechRoute, emit, history, record, turnScheduler } from './session'

/**
 * Speaks a prepared sentence without going through the LLM. It goes to the session's speech route:
 * TTS in the classic setup, the voice side in GPT-Live. On an engine where the model itself decides
 * what to say (Gemini Live) the model reads the sentence and records it from its own output
 * transcript. Nothing starts while a user turn is in progress, and what was spoken is written to the
 * conversation log as an assistant utterance.
 */
export async function interject(text: string): Promise<void> {
  const owner = conversationOwner()
  if (owner) {
    await owner.say(text)
    return
  }
  const route = currentSpeechRoute()
  const handle = turnScheduler.startIfIdle(async ({ turnId, signal }) => {
    // A user turn that replaced this one before it began has nothing of it to close.
    if (signal.aborted) return
    emit({ type: 'started', turnId, origin: 'interject' })
    history.ensureLoaded()
    const synth = route.open({ turnId, signal, emit })
    const assembler = new SegmentAssembler(conversationLocale())
    for (const s of assembler.push(text + '\n')) synth.push(s)
    for (const s of assembler.flush()) synth.push(s)
    await synth.drain()
    if (signal.aborted) return
    // When the voice side reads the text, the live engine records the output transcript of what was actually spoken.
    if (route.kind === 'tts') record({ kind: 'assistant', turnId, text })
    emit({ type: 'done', turnId, fullText: text })
  })
  if (!handle) return
  await handle.completion
}
