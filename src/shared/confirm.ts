/**
 * The shared shape of the approval gate. The main process asks before an operation that reaches
 * outside or is hard to undo, and the renderer answers from a confirmation screen inside the app; no
 * native dialog is used. If the requester aborts before an answer arrives, a `close` event follows and
 * the screen goes away.
 */

export interface ConfirmRequest {
  id: string
  /** The heading at the top left, such as "メールの操作を確認". */
  title: string
  /** The question in one sentence, such as "この内容でメールを操作しますか?". */
  message: string
  /** What is about to happen. Line breaks are rendered as they are. */
  detail: string
  /** The label of the button that carries the operation out. */
  confirmLabel: string
  /** The operation removes something, such as a mail going to the trash, and its button is drawn as a warning. */
  destructive: boolean
}

export type ConfirmEvent = { type: 'open'; request: ConfirmRequest } | { type: 'close'; id: string }
