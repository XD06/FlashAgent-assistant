import { join } from 'node:path'
import { app } from 'electron'
import { migrateLegacyUserData } from './legacyDataMigration'

const LEGACY_USER_DATA_DIR = 'selection-assistant-lite'

// The package rename changes Electron's default userData directory. Electron
// may create caches before this module runs, so migration cannot rely on the
// target directory being absent.
function migrateLegacyAppData(): void {
  const userDataDir = app.getPath('userData')
  const legacyUserDataDir = join(app.getPath('appData'), LEGACY_USER_DATA_DIR)
  const result = migrateLegacyUserData(legacyUserDataDir, userDataDir)
  if (result.error) console.warn('Could not migrate legacy user data:', result.error)
}

migrateLegacyAppData()
