import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewStore } from '../src/renderer/src/state/view'

const turn = vi.hoisted(() => ({ activeTurnId: 7, setRouterNote: vi.fn() }))

vi.mock('@/voice/VoiceController', () => ({
  voiceController: { current: 'off', msSinceBackchannel: Infinity, events: { on: vi.fn() } }
}))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { isPlaying: false } }))
vi.mock('@/voice/aizuchi-bank', () => ({ loadAizuchiBank: vi.fn(), pickAizuchi: vi.fn(() => null), pickListeningClip: vi.fn(() => null) }))
vi.mock('@/state/stores', () => ({
  useTurnStore: { getState: () => turn },
  useFeedStore: { getState: () => ({}) },
  useJobStore: { getState: () => ({}) },
  usePanelStore: { getState: () => ({}) },
  useSettingsStore: { getState: () => ({ settings: null }) },
  useStatusStore: { getState: () => ({}) },
  useToastStore: { getState: () => ({ push: vi.fn() }) }
}))

describe('the app turn event', () => {
  beforeEach(() => {
    useViewStore.getState().closeApp()
  })

  it('opens the mini app at the target, and a null target closes the open one', async () => {
    const { handleTurnEvent } = await import('../src/renderer/src/conversation')
    handleTurnEvent({ type: 'app', turnId: 7, open: { app: 'settings', page: 'voice' } })
    expect(useViewStore.getState().open).toEqual({ app: 'settings', page: 'voice' })
    handleTurnEvent({ type: 'app', turnId: 7, open: { app: 'mail', draftId: 'd1' } })
    expect(useViewStore.getState().open).toMatchObject({ app: 'mail', box: 'drafts', pane: { kind: 'draft', id: 'd1' } })
    handleTurnEvent({ type: 'app', turnId: 7, open: null })
    expect(useViewStore.getState().open).toBeNull()
  })

  it('ignores the event of a turn that is no longer the active one', async () => {
    const { handleTurnEvent } = await import('../src/renderer/src/conversation')
    handleTurnEvent({ type: 'app', turnId: 6, open: { app: 'notes' } })
    expect(useViewStore.getState().open).toBeNull()
  })
})
