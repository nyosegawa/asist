import { deriveCapabilities, type Machine, type PlatformCapabilities } from '@shared/platform'

const machine = (platform: string, arch: string, micCancelsEcho: boolean): Machine => ({
  platform,
  arch,
  totalMemoryBytes: 32 * 1024 ** 3,
  micCancelsEcho: () => micCancelsEcho
})

/**
 * The capabilities of a 32 GB Apple Silicon Mac and of an x64 Windows PC whose microphone Windows does not
 * cancel the echo on, which captures through getUserMedia.
 */
export const MACOS = deriveCapabilities(machine('darwin', 'arm64', true))
export const WINDOWS = deriveCapabilities(machine('win32', 'x64', false))

let current: PlatformCapabilities = MACOS

/**
 * Stands in for the platform module of the main process and of the renderer, so that a test decides
 * the machine rather than the one it runs on: `vi.mock('@/platform', () => import('./helpers/platform'))`.
 */
export const platformCapabilities = (): PlatformCapabilities => current
export const loadPlatformCapabilities = async (): Promise<void> => {}

/** Makes the mocked module answer with these capabilities until the next call. */
export function setCapabilities(capabilities: PlatformCapabilities): void {
  current = capabilities
}
