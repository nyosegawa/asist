import { defineConfig } from 'vite'

// Served on every interface so a phone on the same tailnet can open it by the machine's Tailscale name.
export default defineConfig({
  server: { host: true, port: 5194, strictPort: true, allowedHosts: ['.ts.net'] },
  preview: { host: true, port: 5194, strictPort: true, allowedHosts: ['.ts.net'] }
})
