import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const LEGACY_USER_DATA_DIR = 'selection-assistant-lite'

// The package rename changes Electron's default userData directory. Copy once
// before electron-store initializes so existing local settings stay available.
function migrateLegacyUserData(): void {
  const userDataDir = app.getPath('userData')
  const legacyUserDataDir = join(app.getPath('appData'), LEGACY_USER_DATA_DIR)
  if (userDataDir === legacyUserDataDir || existsSync(userDataDir) || !existsSync(legacyUserDataDir)) return

  try {
    cpSync(legacyUserDataDir, userDataDir, { recursive: true, force: false, errorOnExist: false })
  } catch (error) {
    console.warn('Could not migrate legacy user data:', error)
  }
}

migrateLegacyUserData()
