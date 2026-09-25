import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { initConversation } from '@/conversation'
import { translate, useT, useUiLocale } from '@/i18n'
import { usePanelStore, useSettingsStore, useTurnStore } from '@/state/stores'
import { applyTheme, DEFAULT_THEME } from '@/themes'
import { activeMiniApp, useViewStore } from '@/state/view'
import { Starfield } from '@/ui/Starfield'
import { TopBar } from '@/ui/TopBar'
import { Orb } from '@/ui/Orb'
import { Feed } from '@/ui/Feed'
import { Dock } from '@/ui/Dock'
import { NavigationDock } from '@/ui/NavigationDock'
import { Toasts } from '@/ui/Toasts'
import { ConfirmSheet } from '@/ui/ConfirmSheet'
import { SettingsDialog } from '@/ui/SettingsDialog'
import { JobsView } from '@/ui/JobsView'
import { FocusOverlay } from '@/ui/FocusOverlay'
import { SetupWizard } from '@/ui/SetupWizard'
import { CalendarView } from '@/ui/calendar/CalendarView'
import { TasksView } from '@/ui/tasks/TasksView'
import { MailView } from '@/ui/mail/MailView'
import { MemoryView } from '@/ui/memory/MemoryView'
import { NotesView } from '@/ui/notes/NotesView'
import type { AppTimer } from '@shared/ipc'
import type { MiniApp } from '@shared/mini-apps'
import { syncTimerEvent } from '@/panels/timer-sync'
import orbImage from '@/assets/holo/orb.png'
import { displayError } from '@/display-error'

const PHASE_LABEL: Record<string, { text: string; color: string }> = {
  idle: { text: 'IDLE', color: 'var(--hud-idle-text)' },
  listen: { text: 'LISTENING', color: 'var(--color-holo-cyan)' },
  think: { text: 'ROUTING · LLM', color: 'var(--color-holo-violet)' },
  speak: { text: 'SPEAKING', color: 'var(--color-holo-peach)' }
}

function StateChip(): React.JSX.Element {
  const phase = useTurnStore((s) => s.phase)
  const { text, color } = PHASE_LABEL[phase]
  return (
    <span
      className="state-chip"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
        textShadow: `0 0 12px color-mix(in srgb, ${color} calc(60% * var(--ui-glow-strength)), transparent)`
      }}
    >
      {text}
    </span>
  )
}

/**
 * The size of the orb. It follows the window height on the conversation screen and shrinks while a
 * workspace is open. The canvas keeps the conversation size and the frame is scaled down with its
 * margins pulled in, so that the change of size stays smooth.
 */
function useOrbFrame(workspaceOpen: boolean): { size: number; scale: number; inset: number } {
  const [height, setHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = (): void => setHeight(window.innerHeight)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  const size = Math.round(Math.min(320, height * 0.36))
  const small = Math.round(Math.min(210, height * 0.26))
  return workspaceOpen ? { size, scale: small / size, inset: -Math.round((size - small) / 2) } : { size, scale: 1, inset: 0 }
}

/** Brings timers that stayed active across a restart back into view. Expiry and notification remain owned by main. */
function TimerRestorer(): null {
  useEffect(() => {
    let mounted = true
    const showTimer = (timer: AppTimer): void => {
      // Finished timers whose notification already went out are not shown again. Only active timers
      // and a notification still in the outbox are upserted from main's committed state, and they
      // survive the generation check that discards the panels of an old turn.
      if (timer.status !== 'active' && timer.notificationStatus !== 'pending') return
      usePanelStore.getState().apply(
        {
          op: 'create',
          key: timer.id,
          type: 'timer',
          slot: 'right',
          props: { seconds: timer.seconds, label: timer.label },
          state: 'ready',
          source: translate('cardsTime.timer.source')
        }
      )
    }
    const unsubscribe = window.api.onTimerEvent((event) => {
      if (!mounted) return
      syncTimerEvent(event, {
        show: showTimer,
        dismiss: (id) => usePanelStore.getState().dismiss(id)
      })
    })
    void window.api
      .timerList()
      .then((timers) => {
        if (!mounted) return
        for (const timer of timers) showTimer(timer)
      })
      .catch((err: unknown) => console.warn('timer restore failed:', err))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])
  return null
}

function WorkspaceView({ kind }: { kind: MiniApp }): React.JSX.Element {
  switch (kind) {
    case 'settings':
      return <SettingsDialog open />
    case 'jobs':
      return <JobsView open />
    case 'calendar':
      return <CalendarView open />
    case 'tasks':
      return <TasksView open />
    case 'mail':
      return <MailView open />
    case 'memory':
      return <MemoryView open />
    case 'notes':
      return <NotesView open />
  }
}

/** A workspace slides in from the left and leaves the same way, and switching to another workspace lets the two overlap and dissolve. */
const WORKSPACE_MOTION = {
  initial: { opacity: 0, x: -64 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -64 },
  transition: { duration: 0.36, ease: [0.2, 0.9, 0.25, 1] as const }
}
const ORB_MOTION = { type: 'spring' as const, stiffness: 240, damping: 30, mass: 0.9 }
const STAGE_SLIDE = { duration: 480, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' }

/**
 * The center column, holding the orb, the subtitles and the input, moves to the right column when a
 * workspace opens and back to the middle when it closes. The grid switches in a single frame, so the
 * column is animated from the difference between the old center and the new one, which makes it look
 * pushed aside and coming back. A switch while it is still sliding continues from the position it
 * appears at that moment.
 */
function useStageSlide(workspaceOpen: boolean): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const lastCenter = useRef<number | null>(null)
  const centerOf = (element: HTMLElement): number => {
    const rect = element.getBoundingClientRect()
    return rect.left + rect.width / 2
  }
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const running = element.getAnimations()
    const from = running.length > 0 ? centerOf(element) : lastCenter.current
    for (const animation of running) animation.cancel()
    const center = centerOf(element)
    lastCenter.current = center
    if (from === null || Math.abs(from - center) < 1) return
    element.animate([{ transform: `translateX(${from - center}px)` }, { transform: 'translateX(0)' }], STAGE_SLIDE)
  }, [workspaceOpen])
  // A change of window size makes the reference center be measured again.
  useEffect(() => {
    const onResize = (): void => {
      if (ref.current && ref.current.getAnimations().length === 0) lastCenter.current = centerOf(ref.current)
    }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  return ref
}

type BootState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string }

/** The boot screen, shown only while the settings and the services are being checked. App removes it through AnimatePresence once boot is ready. */
function BootScreen({ boot, onRetry }: { boot: Exclude<BootState, { state: 'ready' }>; onRetry: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <motion.main className="boot" initial={false} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }}>
      <img className="boot-orb" src={orbImage} alt="" />
      <div className="boot-brand">ASIST</div>
      {boot.state === 'loading' ? (
        <>
          <p className="boot-status">{t('boot.checking')}</p>
          <div className="boot-bar" aria-hidden />
        </>
      ) : (
        <section className="glass boot-error">
          <h1>{t('boot.failed')}</h1>
          <p>{boot.message}</p>
          <button onClick={onRetry}>{t('common.retry')}</button>
        </section>
      )}
    </motion.main>
  )
}

export default function App(): React.JSX.Element {
  const workspace = useViewStore(activeMiniApp)
  const workspaceOpen = workspace !== null
  const orb = useOrbFrame(workspaceOpen)
  const stageRef = useStageSlide(workspaceOpen)
  const [bootAttempt, setBootAttempt] = useState(0)
  const [boot, setBoot] = useState<BootState>({ state: 'loading' })
  const uiLocale = useUiLocale()
  const theme = useSettingsStore((state) => state.settings?.theme ?? DEFAULT_THEME)

  // The system font draws a Han character in the Japanese, Korean or Chinese form by the language of the
  // document, and hyphenation and the screen reader's voice follow it too.
  useEffect(() => {
    document.documentElement.lang = uiLocale
  }, [uiLocale])

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    let current = true
    setBoot({ state: 'loading' })
    void initConversation()
      .then(() => {
        if (current) setBoot({ state: 'ready' })
      })
      .catch((error: unknown) => {
        if (current) {
          setBoot({
            state: 'error',
            message: displayError(error)
          })
        }
      })
    return () => {
      current = false
    }
  }, [bootAttempt])

  return (
    <>
      {boot.state === 'ready' && (
        <div className="app-shell is-intro">
          <TimerRestorer />
          <div className="landscape" aria-hidden />
          <Starfield />
          <TopBar />

          <main className={`main${workspaceOpen ? ' is-workspace' : ''}`}>
            <div className="workspace">
              <AnimatePresence mode="popLayout" initial={false}>
                {workspace && (
                  <motion.div key={workspace} className="workspace-view" {...WORKSPACE_MOTION}>
                    <WorkspaceView kind={workspace} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {workspaceOpen ? <div aria-hidden /> : <Dock slot="left" />}

            <section className="stage">
              <div className="stage-inner" ref={stageRef}>
                <motion.div
                  className="orb-frame"
                  animate={{ scale: orb.scale, marginTop: orb.inset, marginBottom: orb.inset }}
                  transition={ORB_MOTION}
                >
                  <Orb size={orb.size} />
                </motion.div>
                <StateChip />
                <Feed />
              </div>
            </section>

            {!workspaceOpen && <Dock slot="right" />}
          </main>

          <NavigationDock />
          <Toasts />
          <FocusOverlay />
          <ConfirmSheet />
          <SetupWizard />
        </div>
      )}
      <AnimatePresence>
        {boot.state !== 'ready' && <BootScreen key="boot" boot={boot} onRetry={() => setBootAttempt((value) => value + 1)} />}
      </AnimatePresence>
    </>
  )
}
