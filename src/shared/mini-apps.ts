import { z } from 'zod'
import { MAIL_VIEWS } from './mail'

/**
 * ASIST's mini apps: the screens opened from the Dock, each with data of its own. The conversation
 * model opens them with open_app and learns from the renderer's report which one is open and what it
 * shows, so the report carries the ids the model's tools take.
 */

export const MINI_APPS = ['notes', 'tasks', 'mail', 'calendar', 'jobs', 'memory', 'settings'] as const
export type MiniApp = (typeof MINI_APPS)[number]

/** The pages of the settings mini app, in the order the list on the left shows them. */
export const SETTINGS_PAGES = ['conversation', 'persona', 'voice', 'appearance', 'memory', 'agent', 'integrations', 'models', 'usage', 'about'] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]

export const MAIL_BOXES = [...MAIL_VIEWS, 'drafts'] as const
export type MailBox = (typeof MAIL_BOXES)[number]

export const CALENDAR_VIEWS = ['month', 'week', 'list'] as const
export type CalendarViewMode = (typeof CALENDAR_VIEWS)[number]

export const TASK_VIEWS = ['board', 'list'] as const
export type TaskViewMode = (typeof TASK_VIEWS)[number]

const id = z.string().min(1)
const localDate = z.iso.date()

const mailPane = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), id }),
  z.strictObject({ kind: z.literal('draft'), id }),
  z.strictObject({ kind: z.literal('compose') })
])

/** What the open mini app shows, as the renderer reports it. Every id is one the model's tools accept. */
export const miniAppViewSchema = z.discriminatedUnion('app', [
  /** `noteId` is the note on screen; `editing` is true while it, or a new note, is being edited. */
  z.strictObject({ app: z.literal('notes'), noteId: id.nullable(), editing: z.boolean() }),
  z.strictObject({ app: z.literal('tasks'), view: z.enum(TASK_VIEWS), taskId: id.nullable() }),
  z.strictObject({ app: z.literal('mail'), box: z.enum(MAIL_BOXES), accountId: id.nullable(), query: z.string(), pane: mailPane.nullable() }),
  /** `date` is the day the view is placed on, and `eventId` the event whose details are open. */
  z.strictObject({ app: z.literal('calendar'), view: z.enum(CALENDAR_VIEWS), date: localDate, eventId: id.nullable() }),
  z.strictObject({ app: z.literal('jobs'), jobId: id.nullable() }),
  /** `file` is the memory document's path relative to the memory folder. */
  z.strictObject({ app: z.literal('memory'), file: id.nullable() }),
  z.strictObject({ app: z.literal('settings'), page: z.enum(SETTINGS_PAGES) })
])
export type MiniAppView = z.infer<typeof miniAppViewSchema>

/** The report of the renderer: the open mini app, or null while only the conversation is shown. */
export const openMiniAppSchema = miniAppViewSchema.nullable()

/** Where open_app opens a mini app. A field left out keeps what the mini app would show by itself. */
export type MiniAppTarget =
  | { app: 'notes'; noteId?: string }
  | { app: 'tasks'; view?: TaskViewMode; taskId?: string }
  | { app: 'mail'; box?: MailBox; messageId?: string; draftId?: string }
  | { app: 'calendar'; view?: CalendarViewMode; date?: string; eventId?: string }
  | { app: 'jobs'; jobId?: string }
  | { app: 'memory'; file?: string }
  | { app: 'settings'; page?: SettingsPage }
