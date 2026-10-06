// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toasts } from '@/ui/Toasts'
import { TOAST_MS, useToastStore } from '@/state/stores'
import { createTranslator } from '@shared/i18n'

// motion's animations do not run in happy-dom, and a cancelled one surfaces as an unhandled AbortError.
vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children),
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(({ initial, animate, exit, ...props }, ref) => createElement('div', { ...props, ref }))
    }
  }
})

const t = createTranslator('ja-JP')
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useToastStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useToastStore.setState({ toasts: [] })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const body = 'The settings file could not be read: /Users/demo/Library/Application Support/ASIST/settings.json: settings.json was written by a newer ASIST.'
const toast = (): HTMLButtonElement | null => container.querySelector('button')

describe('a toast', () => {
  it('shows the whole of its message and stays up while the pointer rests on it, and goes away once the pointer has left', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'error', title: 'Could not check the services', body }))
    expect(toast()?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => void toast()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    expect(toast()?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 3))
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(toast()?.textContent).toContain(body)

    await act(async () => void toast()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    expect(toast()?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => vi.advanceTimersByTime(TOAST_MS - 1))
    expect(useToastStore.getState().toasts).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('stays up while it has the keyboard focus', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'error', title: 'Could not check the services', body }))
    await act(async () => toast()!.focus())
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 2))
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(toast()?.getAttribute('aria-expanded')).toBe('true')
  })

  it('stays up with its whole message while the keyboard is on it, when the pointer passes over it and leaves', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'error', title: 'Could not check the services', body }))
    await act(async () => toast()!.focus())
    await act(async () => void toast()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    await act(async () => void toast()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    expect(toast()?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 2))
    expect(useToastStore.getState().toasts).toHaveLength(1)

    await act(async () => toast()!.blur())
    await act(async () => vi.advanceTimersByTime(TOAST_MS))
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('runs its action and goes away when the action is pressed, leaving the text to dismiss it otherwise', async () => {
    const run = vi.fn()
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'error', title: "Couldn't reply", body, action: { label: 'Manage usage', run } }))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual([`Couldn't reply${body}`, 'Manage usage'])
    await act(async () => buttons[1].click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('stays up while the keyboard moves from its text to its action', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'error', title: "Couldn't reply", body, action: { label: 'Manage usage', run: () => {} } }))
    const [text, action] = [...container.querySelectorAll('button')]
    await act(async () => text.focus())
    await act(async () => action.focus())
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 2))
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('stays up when it is persistent until its close button is pressed', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'info', title: 'Irodori-TTS needs preparing', body, persistent: true, action: { label: 'Prepare', run: () => {} } }))
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 3))
    const [text] = [...container.querySelectorAll('button')]
    await act(async () => void text.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    await act(async () => void text.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(TOAST_MS * 3))
    expect(useToastStore.getState().toasts).toHaveLength(1)

    const close = [...container.querySelectorAll('button')].find((button) => button.textContent === t('common.close'))
    await act(async () => close!.click())
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('keeps a persistent toast when later ones push the oldest out', async () => {
    const { push } = useToastStore.getState()
    push({ kind: 'info', title: 'Irodori-TTS needs preparing', persistent: true })
    for (const title of ['one', 'two', 'three', 'four']) push({ kind: 'ok', title })
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['Irodori-TTS needs preparing', 'two', 'three', 'four'])
  })

  it('goes away by itself when no one rests on it', async () => {
    await act(async () => root.render(<Toasts />))
    await act(async () => useToastStore.getState().push({ kind: 'ok', title: 'Saved' }))
    await act(async () => vi.advanceTimersByTime(TOAST_MS))
    expect(useToastStore.getState().toasts).toEqual([])
  })
})
