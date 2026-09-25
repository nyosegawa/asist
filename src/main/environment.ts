import path from 'node:path'
import dotenv from 'dotenv'
import { errorText } from '@shared/i18n/error-text'

// Runs as the first dependency of index.ts, before any service that reads a setting or an endpoint.
// The parent process's environment wins over cwd/.env. An app opened from Finder or the Dock starts in
// /, so only a run from the repository, such as npm run dev, reads a .env this way.
const file = path.join(process.cwd(), '.env')
const result = dotenv.config({ path: file, override: false, quiet: true })
if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
  throw new Error(errorText('app.startup.envUnreadable', { file, detail: result.error.message }), { cause: result.error })
}
