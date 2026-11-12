import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { migrateLegacyUserData } from './legacyDataMigration'
import { resolvePortableUserDataDir } from './portableData'

const LEGACY_USER_DATA_DIR = 'selection-assistant-lite'

// A portable build carries its own profile next to the exe. Redirect before
// anything reads userData — this module is the first such reader. A read-only
// folder (e.g. Program Files) must not stop the app, so fall back loudly.
let usingPortableProfile = false
const portableDir = app.isPackaged ? resolvePortableUserDataDir(process.env) : null
if (portableDir) {
  try {
    mkdirSync(portableDir, { recursive: true })
    app.setPath('userData', portableDir)
    usingPortableProfile = true
  } catch (error) {
    console.error('[portable] cannot use the data folder, falling back to %APPDATA%:', error)
  }
}

// The package rename changes Electron's default userData directory. Electron
// may create caches before this module runs, so migration cannot rely on the
// target directory being absent. A portable build must never inherit settings
// from a system-wide legacy install: that would overwrite the shipped preset.
function migrateLegacyAppData(): void {
  if (usingPortableProfile) return
  const userDataDir = app.getPath('userData')
  const legacyUserDataDir = join(app.getPath('appData'), LEGACY_USER_DATA_DIR)
  const result = migrateLegacyUserData(legacyUserDataDir, userDataDir)
  if (result.error) console.warn('Could not migrate legacy user data:', result.error)
}

migrateLegacyAppData()
