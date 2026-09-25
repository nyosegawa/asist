import { app } from 'electron'

/**
 * How ASIST names itself to the services the main process calls: the application, its version and
 * the project's URL, so that whoever runs a service can tell where the requests come from.
 */
export const userAgent = (): string => `ASIST/${app.getVersion()} (https://github.com/nyosegawa/asist)`
