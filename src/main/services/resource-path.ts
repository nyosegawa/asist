import path from 'node:path'
import { app } from 'electron'

/** A file or folder the app ships under resources/, in the installed app and in a checkout alike. */
export function resourcePath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'resources', name)
}
