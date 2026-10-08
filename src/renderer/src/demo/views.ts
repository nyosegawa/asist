import { describeCalendarEvent, type CalendarEventInput, type CalendarStatus } from '@shared/calendar'
import type { PreparationProgress, RendererApi } from '@shared/ipc'
import type { SettingsPage } from '@shared/mini-apps'
import { localTtsModel, type LocalTtsEngine } from '@shared/tts-models'
import { ASR_MODEL_SPECS, asrModelFiles } from '@shared/asr-models'
import type { PinnedFile } from '@shared/pinned-file'
import { dayKey } from '@shared/calendar-layout'
import { DEMO_SPEECH_CATALOG } from './speech-catalog'
import { errorText } from '@shared/i18n/error-text'
import { displayError } from '@/display-error'
import { formatLocale, tConversation, translate } from '@/i18n'
import { useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { useConfirmStore } from '@/state/confirm'
import type { ScreenName } from './screens'
import { prepareSetupDemo } from './setup-demo'
import { DEMO_NOTES } from './fixtures/notes'
import { DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGES } from './fixtures/mail'
import { DEMO_CALENDAR_STATUS } from './fixtures/calendar'
import { demoUsageDays } from './fixtures/usage'
import { DEMO_CHATGPT_ACCOUNT, setDemoChatGpt } from './chatgpt-demo'
import { manageUsageAction } from '@/chatgpt'
import { defaultModelsFor } from '@shared/llm-catalog'
import type { ChatGptStatus } from '@shared/chatgpt'

/**
 * How the demo opens each screen and state. The names and how they appear in the list live in
 * screens.ts, and the entry point (index.tsx) looks them up here by name. Writing the links out
 * separately does not work: after a screen was renamed from diary to memory, the list still held the old
 * name and opening it failed.
 *
 * - prepare: replaces parts of the mock API before the app is rendered, as the first-run setup, the boot
 *   screen and the boot failure need.
 * - open: drives the stores to show a screen or a sheet.
 * - say: the utterances sent in order at startup.
 */
export interface DemoView {
  prepare?: (api: RendererApi) => void
  open?: () => void
  say?: string[]
}

const view = (): ReturnType<typeof useViewStore.getState> => useViewStore.getState()
const settingsPage = (page: SettingsPage): DemoView => ({ open: () => view().openApp({ app: 'settings', page }) })

/** The voice page with a local engine whose model is prepared, where its voices are chosen by listening. */
const localTtsVoices = (engine: LocalTtsEngine): DemoView => ({
  ...settingsPage('voice'),
  prepare: (api) => {
    void api.saveSettings({ ttsEngine: engine })
    const getStatus = api.getStatus
    api.getStatus = async () => ({ ...(await getStatus()), tts: 'ready', ttsEngine: engine })
  }
})

/**
 * The calendar and mail page without a Google sign-in, or holding a sign-in another build saved. Signing
 * in from the page succeeds at once, and signing out goes back to the page without an account.
 */
const googleSignedOutSettings = (signIn: 'signedOut' | 'unreadable'): DemoView => ({
  prepare: (api) => {
    const signedOut: CalendarStatus = { signIn: 'signedOut', calendars: [], account: null }
    let status: CalendarStatus = { ...signedOut, signIn }
    api.calendarStatus = async () => status
    api.calendarRequestAccess = async () => (status = DEMO_CALENDAR_STATUS)
    api.calendarSignOut = async () => (status = signedOut)
    void api.saveSettings({ calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null } })
  },
  open: () => view().openApp({ app: 'settings', page: 'connections' })
})

/**
 * A settings page with the sign-in with ChatGPT in the given state. With `models`, the conversation and the
 * bridge phrase run on ChatGPT's default pair.
 */
const chatgptSettings = (page: SettingsPage, status: ChatGptStatus, models: boolean): DemoView => ({
  prepare: (api) => {
    setDemoChatGpt(status)
    if (models) void api.saveSettings(defaultModelsFor('chatgpt'))
  },
  open: () => view().openApp({ app: 'settings', page })
})

/** The usage page after the conversation moved from an OpenAI key to the ChatGPT plan two weeks ago. */
const usageOnPlan: DemoView = {
  prepare: (api) => {
    setDemoChatGpt({ signIn: 'signedIn', account: DEMO_CHATGPT_ACCOUNT })
    void api.saveSettings(defaultModelsFor('chatgpt'))
    api.apiUsage = async () => demoUsageDays(new Date(), true)
  },
  open: () => view().openApp({ app: 'settings', page: 'usage' })
}

let usageToastTimer: ReturnType<typeof setInterval> | undefined

/** The toast of a reply that failed on the plan's usage limit, pushed again while someone looks at it, as the other toasts are. */
function showUsageToast(): void {
  const push = (): void => {
    useToastStore.getState().push({
      kind: 'error',
      title: translate('conversation.replyFailed'),
      body: tConversation('conversation.reply.chatgptUsageLimit'),
      action: manageUsageAction()
    })
  }
  if (usageToastTimer) return
  push()
  usageToastTimer = setInterval(push, 5000)
}

/**
 * The notices at launch of a Mac on which an update pinned other files of Irodori-TTS and of the speech
 * recognition model, for someone who listens through in-browser Whisper until it is prepared or without it.
 * Pressing the notice of Irodori-TTS starts a preparation that stops at 40% and never finishes, so the voice
 * page it opens keeps showing the progress.
 */
const speechModelNotices = ({ press = false, whisper = false }: { press?: boolean; whisper?: boolean }): DemoView => ({
  prepare: (api) => {
    void api.saveSettings({ ttsEngine: 'irodori', localAsrEnabled: whisper })
    const getStatus = api.getStatus
    api.getStatus = async () => ({ ...(await getStatus()), tts: 'down', ttsEngine: 'irodori' })
    const reading = localTtsModel('irodori', '0.6b', DEMO_SPEECH_CATALOG)
    const recognition = ASR_MODEL_SPECS['qwen3-asr-1.7b']
    const bytes = (files: readonly PinnedFile[]): number => files.reduce((sum, file) => sum + file.bytes, 0)
    api.speechModelNotices = async () => [
      { target: 'tts', label: reading.label, downloadBytes: bytes(reading.files) },
      { target: 'asr', label: recognition.label, downloadBytes: bytes(asrModelFiles(recognition, DEMO_SPEECH_CATALOG)) }
    ]
    let listener: ((progress: PreparationProgress) => void) | null = null
    api.onSetupProgress = (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    }
    api.prepareTtsModel = () => {
      setTimeout(() => listener?.({ target: 'tts', status: 'downloading', pct: 40, downloadedMb: 754.1, totalMb: 1885 }), 100)
      return new Promise(() => {})
    }
  },
  ...(press ? { open: () => clickWhenReady('[data-toast] [data-tone="primary"]') } : {})
})

/**
 * Semantic search on the memory page while its model downloads. The download stops at 40% and never
 * finishes, so the progress stays on the screen.
 */
const semanticSearchPreparing: DemoView = {
  prepare: (api) => {
    const notInstalled = api.embeddingStatus
    api.embeddingStatus = async () => ({ ...(await notInstalled()), runtimeInstalled: false, modelInstalled: false })
    let listener: ((progress: PreparationProgress) => void) | null = null
    api.onSetupProgress = (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    }
    api.embeddingPrepare = () => {
      setTimeout(() => listener?.({ target: 'embedding', status: 'downloading', pct: 40, downloadedMb: 54, totalMb: 135 }), 100)
      return new Promise(() => {})
    }
  },
  open: () => {
    view().openApp({ app: 'settings', page: 'memory' })
    clickWhenReady('[data-prep="embedding"]')
  }
}

/**
 * The settings when main cannot say what is installed, as when the folder of the models cannot be read.
 * Each row that waits on it says the check failed and gives the reason; the aizuchi are on so that the
 * classifier's row shows it too.
 */
const statusesUnreadable = (page: SettingsPage): DemoView => ({
  ...settingsPage(page),
  prepare: (api) => {
    const fail = (): Promise<never> => Promise.reject(new Error("EACCES: permission denied, scandir '/Users/demo/Library/Application Support/ASIST/models'"))
    api.getSetupStatus = fail
    api.vapStatus = fail
    api.embeddingStatus = fail
    api.aizuchiClassifierStatus = fail
    api.hotkeyStatus = fail
    void api.saveSettings({ aizuchi: true })
  }
})

/** The memory page right after semantic search is turned on: each reading of the count finds five more memories converted, up to 45. */
const memoriesConverting: DemoView = {
  prepare: (api) => {
    void api.saveSettings({ memoryEmbeddingEnabled: true })
    let embedded = 0
    api.embeddingStatus = async () => {
      const status = { runtimeInstalled: true, modelInstalled: true, running: true, enabled: true, converting: embedded < 45, embedded, total: 45, model: 'multilingual-e5-small' }
      embedded = Math.min(45, embedded + 5)
      return status
    }
  },
  ...settingsPage('memory')
}

/** The week view on the day of an event with its details open, as open_app places it from the conversation. */
async function openCalendarEvent(title: string): Promise<void> {
  const from = new Date()
  const events = await window.api.calendarEvents({ start: from.toISOString(), end: new Date(from.getTime() + 30 * 86_400_000).toISOString() })
  const event = events.find((candidate) => candidate.title === title)
  if (!event) throw new Error(`demo: 予定 ${title} が見つかりません`)
  view().openApp({ app: 'calendar', view: 'week', date: dayKey(new Date(event.start)), eventId: event.id })
}

let toastTimer: ReturnType<typeof setInterval> | undefined

/** A toast disappears after five seconds, so they are pushed again while someone is looking at them. */
function showToasts(): void {
  const push = (): void => {
    const toasts = useToastStore.getState()
    toasts.push({ kind: 'ok', title: translate('voice.services.title'), body: [translate('voice.services.recognitionBack'), translate('voice.services.speechBack')].join(' · ') })
    toasts.push({ kind: 'info', title: translate('voice.engineChanged.title'), body: translate('voice.engineChanged.body') })
    toasts.push({ kind: 'error', title: translate('conversation.sendFailed'), body: translate('conversation.reply.network') })
    // A long error, which the toast cuts at two lines until the pointer rests on it.
    const unreadable = errorText('settings.errors.readFailed', {
      file: '/Users/demo/Library/Application Support/ASIST/settings.json',
      message: errorText('app.storage.versionTooNew', { file: 'settings.json', version: 9, supported: 4 })
    })
    toasts.push({ kind: 'error', title: translate('app.status.checkFailed'), body: displayError(new Error(unreadable)) })
  }
  // Opened again after a change of language, the next push is already in that language.
  if (toastTimer) return
  push()
  toastTimer = setInterval(push, 5000)
}

/** The confirmation of a calendar change, written as the main process writes it: the event now, for an update, and the event to save. */
function calendarConfirm(operation: 'create' | 'update', after: CalendarEventInput, before?: CalendarEventInput): DemoView {
  const describe = (heading: 'calendar.confirm.before' | 'calendar.confirm.after', event: CalendarEventInput): string =>
    `${translate(heading)}\n${describeCalendarEvent(translate, formatLocale(), event)}`
  return {
    open: () =>
      useConfirmStore.getState().open({
        id: 'demo-confirm',
        title: translate('calendar.confirm.title'),
        message: translate('calendar.confirm.message'),
        detail: [
          translate(`calendar.confirm.${operation}`, { calendar: '仕事' }),
          ...(before ? [describe('calendar.confirm.before', before)] : []),
          describe('calendar.confirm.after', after)
        ].join('\n\n'),
        confirmLabel: translate('calendar.confirm.action'),
        destructive: false,
        holdsConversation: true
      })
  }
}

/** A call kept in New York, whose time the confirmation shows on this computer's clock and on New York's. */
const newYorkCall = (start: string, end: string): CalendarEventInput => ({
  title: '取引先と電話会議',
  start,
  end,
  allDay: false,
  timeZone: 'America/New_York',
  location: 'Zoom',
  notes: '来期の契約の条件を確認する'
})

export const DEMO_VIEWS: Record<ScreenName, DemoView> = {
  conversation: {},
  'conversation/cards': { say: ['長野県の今日の天気を教えて', 'ドル円のレートを教えて'] },
  calendar: { open: () => view().openApp({ app: 'calendar' }) },
  settings: { open: () => view().openApp({ app: 'settings' }) },
  jobs: { open: () => view().openApp({ app: 'jobs' }) },
  tasks: { open: () => view().openApp({ app: 'tasks' }) },
  mail: { open: () => view().openApp({ app: 'mail' }) },
  memory: { open: () => view().openApp({ app: 'memory' }) },
  notes: { open: () => view().openApp({ app: 'notes' }) },
  'notes/note': { open: () => view().openApp({ app: 'notes', noteId: DEMO_NOTES[2].id }) },
  'mail/message': { open: () => view().openApp({ app: 'mail', messageId: DEMO_MAIL_MESSAGES[0].id }) },
  'mail/draft-started': { open: () => view().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[2].id }) },
  'calendar/event': { open: () => void openCalendarEvent('リリース判定') },

  'settings/conversation': settingsPage('conversation'),
  'settings/voice': settingsPage('voice'),
  'settings/voice/irodori': localTtsVoices('irodori'),
  'settings/voice/qwen3tts': localTtsVoices('qwen3tts'),
  'settings/persona': settingsPage('persona'),
  'settings/memory': settingsPage('memory'),
  'settings/agent': settingsPage('agent'),
  'settings/connections': settingsPage('connections'),
  'settings/connections/google-signed-out': googleSignedOutSettings('signedOut'),
  'settings/connections/google-unreadable': googleSignedOutSettings('unreadable'),
  'settings/language': settingsPage('language'),
  'settings/appearance': settingsPage('appearance'),
  'settings/api-keys': settingsPage('apiKeys'),
  'settings/api-keys/chatgpt-signed-in': chatgptSettings('apiKeys', { signIn: 'signedIn', account: DEMO_CHATGPT_ACCOUNT }, true),
  'settings/api-keys/chatgpt-returning': chatgptSettings('apiKeys', { signIn: 'signedOut', account: DEMO_CHATGPT_ACCOUNT }, false),
  'settings/api-keys/chatgpt-unreadable': chatgptSettings('apiKeys', { signIn: 'unreadable', account: null }, false),
  'settings/conversation/chatgpt': chatgptSettings('conversation', { signIn: 'signedIn', account: DEMO_CHATGPT_ACCOUNT }, true),
  'settings/conversation/chatgpt-signed-out': chatgptSettings('conversation', { signIn: 'signedOut', account: DEMO_CHATGPT_ACCOUNT }, true),
  'settings/usage': settingsPage('usage'),
  'settings/usage/chatgpt': usageOnPlan,
  'settings/about': settingsPage('about'),
  'settings/memory/preparing': semanticSearchPreparing,
  'settings/memory/converting': memoriesConverting,
  'settings/check-failed': statusesUnreadable('overview'),
  'settings/voice/check-failed': statusesUnreadable('voice'),

  setup: { prepare: (api) => prepareSetupDemo(api, 'fresh') },
  'setup/key-failed': { prepare: (api) => prepareSetupDemo(api, 'key-failed') },
  'setup/mic-denied': { prepare: (api) => prepareSetupDemo(api, 'mic-denied') },
  'setup/tts-missing': { prepare: (api) => prepareSetupDemo(api, 'tts-missing') },
  'setup/live-key-failed': { prepare: (api) => prepareSetupDemo(api, 'live-key-failed') },
  'setup/chatgpt': { prepare: (api) => prepareSetupDemo(api, 'chatgpt') },
  'setup/chatgpt-returning': { prepare: (api) => prepareSetupDemo(api, 'chatgpt-returning') },
  // Someone who finished the setup before the notice of the risks existed sees it once at launch.
  safety: { prepare: (api) => void api.saveSettings({ safetyNoticeVersion: 0 }) },
  boot: {
    // While the status request never resolves, the app stays on the boot screen.
    prepare: (api) => {
      api.getStatus = () => new Promise(() => {})
    }
  },
  'boot/error': {
    prepare: (api) => {
      api.getStatus = async () => {
        throw new Error(errorText('app.startup.envUnreadable', { file: '/Users/demo/src/asist/.env', detail: 'EACCES: permission denied' }))
      }
    }
  },
  confirm: {
    open: () =>
      useConfirmStore.getState().open({
        id: 'demo-confirm',
        title: translate('mail.confirm.title'),
        message: translate('mail.confirm.message'),
        detail: [
          translate('mail.confirm.send', { label: '仕事', email: 'me@example.com' }),
          translate('mail.confirm.to', { addresses: '田中 一郎 <tanaka@example.com>' }),
          translate('mail.confirm.subject', { subject: '来週の打合せについて' }),
          translate('mail.confirm.body', { body: '火曜の14時でお願いします。場所は前回と同じ会議室で大丈夫です。' })
        ].join('\n\n'),
        confirmLabel: translate('mail.confirm.action.send'),
        destructive: false,
        holdsConversation: true
      })
  },
  'confirm/calendar': calendarConfirm(
    'update',
    newYorkCall('2026-09-15T10:00:00-04:00', '2026-09-15T11:00:00-04:00'),
    newYorkCall('2026-09-15T09:00:00-04:00', '2026-09-15T10:00:00-04:00')
  ),
  'confirm/calendar-all-day': calendarConfirm('create', {
    title: '大阪出張',
    start: '2026-09-28',
    end: '2026-10-02',
    allDay: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location: '大阪支社',
    notes: ''
  }),
  toasts: { open: showToasts },
  'toasts/chatgpt-usage': { open: showUsageToast },
  'toasts/speech-models': speechModelNotices({}),
  'toasts/speech-models/whisper': speechModelNotices({ whisper: true }),
  'toasts/speech-models/preparing': speechModelNotices({ press: true })
}

/** Waits until the element is rendered and then presses it, to reach a state inside a screen such as one page of the settings. */
export function clickWhenReady(selector: string): void {
  const started = Date.now()
  const timer = setInterval(() => {
    const target = document.querySelector<HTMLElement>(selector)
    if (target) {
      clearInterval(timer)
      target.click()
    } else if (Date.now() - started > 10_000) {
      clearInterval(timer)
      throw new Error(`demo: ${selector} が見つかりません`)
    }
  }, 50)
}
