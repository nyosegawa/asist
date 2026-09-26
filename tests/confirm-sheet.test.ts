// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { CONFIRM_ARM_MS, ConfirmSheet } from '../src/renderer/src/ui/ConfirmSheet'
import { askConfirm, useConfirmStore } from '../src/renderer/src/state/confirm'
import { displayError } from '../src/renderer/src/display-error'

vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  const plain = (tag: string) =>
    forwardRef<HTMLElement, Record<string, unknown>>(({ initial, animate, exit, transition, ...props }, ref) => createElement(tag, { ...props, ref }))
  return { AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children), motion: { div: plain('div'), section: plain('section') } }
})

const t = createTranslator('ja-JP')
const api = { confirmResolve: vi.fn(async () => {}) }
let container: HTMLDivElement
let root: Root
const request = { id: 'c1', title: t('mail.confirm.title'), message: 'この内容でメールを操作しますか？', detail: '仕事 の「質問」を Trash へ移します。', confirmLabel: 'この内容で実行', destructive: false }
const later = { id: 'c2', title: t('calendar.confirm.title'), message: 'この内容で予定を保存しますか？', detail: '9月15日 10:00 打合せ', confirmLabel: t('common.save'), destructive: false }

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  api.confirmResolve.mockClear()
  useConfirmStore.setState({ queue: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function render(): Promise<void> {
  await act(async () => root.render(React.createElement(ConfirmSheet)))
}

/** Lets the request on screen be on screen long enough for a press to answer it. */
async function armed(): Promise<void> {
  await act(async () => vi.advanceTimersByTime(CONFIRM_ARM_MS))
}

const pressPrimary = (): Promise<void> => act(async () => container.querySelector<HTMLButtonElement>('.cal-primary')!.click())
const pressEscape = (): Promise<void> => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))

describe('ConfirmSheet', () => {
  it('shows the message and the confirm button, then returns true to main and closes when confirm is pressed', async () => {
    await render()
    expect(container.querySelector('.confirm-sheet')).toBeNull()
    await act(async () => useConfirmStore.getState().open(request))
    const sheet = container.querySelector('.confirm-sheet')!
    expect(sheet.querySelector('h2')?.textContent).toBe(request.message)
    expect(sheet.querySelector('.confirm-detail')?.textContent).toBe(request.detail)
    expect(document.activeElement?.textContent).toBe(t('common.cancel'))
    await armed()
    await pressPrimary()
    expect(api.confirmResolve).toHaveBeenCalledWith('c1', true)
    expect(container.querySelector('.confirm-sheet')).toBeNull()
  })

  it('returns false to main once when Escape cancels, and does not answer a second time', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open(request))
    await armed()
    await pressEscape()
    await pressEscape()
    expect(api.confirmResolve).toHaveBeenCalledTimes(1)
    expect(api.confirmResolve).toHaveBeenCalledWith('c1', false)
    expect(container.querySelector('.confirm-sheet')).toBeNull()
  })

  it('disappears without answering when main closes the request', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open(request))
    await act(async () => useConfirmStore.getState().close('other'))
    expect(container.querySelector('.confirm-sheet')).not.toBeNull()
    await act(async () => useConfirmStore.getState().close('c1'))
    expect(container.querySelector('.confirm-sheet')).toBeNull()
    expect(api.confirmResolve).not.toHaveBeenCalled()
  })

  it('answers a confirmation the renderer asked for to the waiting caller, without going to main', async () => {
    await render()
    let answer: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      answer = askConfirm({
        message: t('tasks.confirmDelete', { title: '牛乳を買う' }),
        detail: t('tasks.deleteDetail'),
        confirmLabel: t('tasks.deleteTask'),
        destructive: true
      })
    })
    const sheet = container.querySelector('.confirm-sheet')!
    expect(sheet.querySelector('.confirm-head')).toBeNull()
    await armed()
    await act(async () => sheet.querySelector<HTMLButtonElement>('.confirm-destructive')!.click())
    await expect(answer).resolves.toBe(true)
    expect(api.confirmResolve).not.toHaveBeenCalled()
    expect(container.querySelector('.confirm-sheet')).toBeNull()
  })

  it('cancels a pending delete when main asks for approval, and shows main\'s request instead', async () => {
    await render()
    let answer: Promise<boolean> = Promise.resolve(true)
    await act(async () => {
      answer = askConfirm({ message: t('common.confirmDiscard'), confirmLabel: t('common.discardChanges'), destructive: true })
    })
    await act(async () => useConfirmStore.getState().open(request))
    await expect(answer).resolves.toBe(false)
    expect(container.querySelector('.confirm-sheet h2')?.textContent).toBe(request.message)
    const refused = await askConfirm({ message: 'x', confirmLabel: 'y', destructive: true }).then(
      () => null,
      (error: unknown) => error
    )
    expect(displayError(refused)).toBe(t('confirm.alreadyOpen'))
  })

  it('keeps a second request from main waiting behind the one on screen, then shows it, and answers each once', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open(request))
    await act(async () => useConfirmStore.getState().open(later))
    expect(container.querySelector('.confirm-sheet h2')?.textContent).toBe(request.message)
    await armed()
    await pressPrimary()
    expect(container.querySelector('.confirm-sheet h2')?.textContent).toBe(later.message)
    await armed()
    await pressEscape()
    expect(api.confirmResolve.mock.calls).toEqual([
      ['c1', true],
      ['c2', false]
    ])
    expect(container.querySelector('.confirm-sheet')).toBeNull()
  })

  it('drops a waiting request that main closes before it is shown', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open(request))
    await act(async () => useConfirmStore.getState().open(later))
    await act(async () => useConfirmStore.getState().close(later.id))
    await armed()
    await act(async () => container.querySelector<HTMLButtonElement>('.cal-btn')!.click())
    expect(api.confirmResolve.mock.calls).toEqual([['c1', false]])
    expect(container.querySelector('.confirm-sheet')).toBeNull()
  })

  it('ignores every press until a request has been on screen for a moment, and starts that wait again for the next request', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open(request))
    await act(async () => useConfirmStore.getState().open(later))
    await act(async () => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1))
    await pressPrimary()
    await pressEscape()
    await act(async () => container.querySelector<HTMLElement>('.confirm-backdrop')!.click())
    expect(api.confirmResolve).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    await pressPrimary()
    // The second press of a double click lands on the next request, which has taken the same place.
    await pressPrimary()
    expect(container.querySelector('.confirm-sheet h2')?.textContent).toBe(later.message)
    expect(api.confirmResolve.mock.calls).toEqual([['c1', true]])
    await armed()
    await pressPrimary()
    expect(api.confirmResolve.mock.calls).toEqual([
      ['c1', true],
      ['c2', true]
    ])
  })

  it('draws the confirming button as a warning for an operation that removes something, whichever side asked', async () => {
    await render()
    await act(async () => useConfirmStore.getState().open({ ...request, confirmLabel: 'ゴミ箱に移す', destructive: true }))
    expect(container.querySelector('.confirm-destructive')?.textContent).toBe('ゴミ箱に移す')
    await act(async () => useConfirmStore.getState().close(request.id))
    await act(async () => {
      void askConfirm({ message: '「牛乳を買う」を完了にしますか', confirmLabel: '完了として記録', destructive: false })
    })
    expect(container.querySelector('.confirm-destructive')).toBeNull()
    expect(container.querySelector('.cal-primary')?.textContent).toBe('完了として記録')
  })
})
