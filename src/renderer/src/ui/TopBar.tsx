import { Mic, MicOff } from 'lucide-react'
import { Hud } from './Hud'
import { toggleMic } from '@/conversation'
import { isLiveEngine } from '@shared/voice-engine'
import type { SpeechEngineState } from '@shared/ipc'
import { useT } from '@/i18n'
import { useLiveStore, useSettingsStore, useStatusStore, useTurnStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import asistIcon from '@/assets/holo/asist.png'

/** A light that is on, off for a fault, or dim for a local model that is loading or not loaded because nothing needs it. */
type Light = 'ok' | 'idle' | 'down'

const engineLight = (state: SpeechEngineState): Light => (state === 'ready' ? 'ok' : state === 'down' ? 'down' : 'idle')

function StatusDot({ light, label }: { light: Light; label: string }): React.JSX.Element {
  return (
    <span className={`status-dot${light === 'down' ? '' : ` is-${light}`}`}>
      <i />
      {label}
    </span>
  )
}

export function TopBar(): React.JSX.Element {
  const t = useT()
  const status = useStatusStore((s) => s.status)
  const micState = useTurnStore((s) => s.micState)
  const micProgress = useTurnStore((s) => s.micProgress)
  const closeApp = useViewStore((s) => s.closeApp)
  const engine = useSettingsStore((s) => s.settings?.voiceEngine ?? 'cascade')
  const showHud = useSettingsStore((s) => s.settings?.showHud === true)
  const liveConnection = useLiveStore((s) => s.connection)

  return (
    <header className="topbar drag-region">
      <button className="brand" onClick={closeApp} aria-label={t('common.backToConversation')}>
        <img src={asistIcon} alt="" />
        <span>ASIST</span>
      </button>

      {/* The wrap stays when the bar is hidden, because it is what pushes the status dots and the microphone to the right. */}
      <div className="hud-wrap">{showHud && <Hud />}</div>

      {status && (
        <div className="status-dots">
          <StatusDot light={status.llm ? 'ok' : 'down'} label="LLM" />
          {isLiveEngine(engine) ? (
            <StatusDot light={liveConnection === 'open' || liveConnection === 'idle' ? 'ok' : 'down'} label="GEMINI" />
          ) : (
            <>
              <StatusDot light={engineLight(status.asr)} label="ASR" />
              <StatusDot light={engineLight(status.tts)} label="TTS" />
            </>
          )}
          <StatusDot light={status.agent === 'found' ? 'ok' : 'down'} label="AGENT" />
        </div>
      )}

      <button
        onClick={() => void toggleMic()}
        className={`mic${micState === 'on' ? ' is-on' : micState === 'loading' ? ' is-loading holo-pulse' : ''}`}
        aria-label={micState === 'on' ? t('navigation.mic.turnOff') : t('navigation.mic.turnOn')}
      >
        {micState === 'on' ? <Mic size={13} /> : <MicOff size={13} />}
        {micState === 'on' ? 'LIVE' : micState === 'loading' ? `LOAD ${Math.round(micProgress)}%` : 'MIC OFF'}
      </button>
    </header>
  )
}
