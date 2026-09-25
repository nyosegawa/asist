import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5194, strictPort: true },
  preview: { port: 5194, strictPort: true }
})
