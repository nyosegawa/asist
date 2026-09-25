import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // What a passing test logs, such as a warning it provokes on purpose, filled more than a thousand lines of
    // CI's log around the results. A failing test still shows everything it logged.
    silent: 'passed-only',
  }
})
