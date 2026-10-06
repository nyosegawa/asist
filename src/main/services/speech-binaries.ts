import { resourcePath } from './resource-path'

/**
 * The binary the local speech runs on, which scripts/resources puts under resources and electron-builder.yml
 * ships: speech.cpp's `speech`, whose `worker` subcommand runs the speech recognition and the speech synthesis
 * and whose `devices` lists the GPUs.
 */

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

export function speechPath(): string {
  return resourcePath(`speech/${exe('speech')}`)
}
