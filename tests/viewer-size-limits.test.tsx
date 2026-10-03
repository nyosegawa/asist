// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TEXT_BYTES, type FileItem, type FileKind } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'

/**
 * The viewer that reads a whole file into the page and parses it there, a notebook's. One larger than its limit is not
 * parsed, and the viewer says it is too large to show here; the card's own button shows it in Finder or File Explorer.
 */

const t = createTranslator('ja-JP')
const itemOf = (kind: FileKind, sizeBytes: number): FileItem => ({ path: `/tmp/big.${kind}`, name: `big.${kind}`, kind, sizeBytes, url: `/demo-files/big.${kind}` })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Renders the viewer with a new key, so that each item starts from its own read, and lets that read begin. */
let mounts = 0
async function render(item: FileItem, size: 'l' | 'focus' = 'l'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer key={mounts++} item={item} mode={size === 'focus' ? 'focus' : 'card'} size={size} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

describe('the size limit of a viewer that reads the whole file', () => {
  it('says a notebook too long to travel whole is too large to show, rather than parsing its beginning', async () => {
    const notebook = { ...itemOf('notebook', MAX_TEXT_BYTES + 1), text: '{"cells": [', truncated: true }
    const view = await render(notebook)
    expect(view.textContent).toContain(t('files.viewer.tooLarge'))
  })
})
