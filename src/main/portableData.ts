import { resolve } from 'node:path'

/**
 * electron-builder's portable launcher sets PORTABLE_EXECUTABLE_DIR to the
 * folder holding the .exe (see app-builder-lib/templates/nsis/portable.nsi).
 * Keeping userData there makes the whole profile travel with the extracted
 * folder instead of living in %APPDATA%. Installed/dev builds leave the env
 * var unset and keep Electron's default location.
 */
export function resolvePortableUserDataDir(env: NodeJS.ProcessEnv): string | null {
  const dir = env.PORTABLE_EXECUTABLE_DIR
  if (typeof dir !== 'string' || !dir.trim()) return null
  return resolve(dir, 'data')
}
