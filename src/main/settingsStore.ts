import Store from 'electron-store'
import { defaultSettings } from '@shared/defaults'
import { mergeSettings, normalizeSettings } from '@shared/actions'
import type { AppSettings, SettingsPatch } from '@shared/types'

const store = new Store<{ settings: AppSettings }>({
  name: 'settings',
  defaults: {
    settings: defaultSettings
  }
})

const listeners = new Set<(settings: AppSettings) => void>()

export function getSettings(): AppSettings {
  return normalizeSettings(store.get('settings'))
}

export function updateSettings(patch: SettingsPatch): AppSettings {
  const next = mergeSettings(getSettings(), patch)
  store.set('settings', next)
  listeners.forEach((listener) => listener(next))
  return next
}

export function onSettingsChanged(listener: (settings: AppSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
