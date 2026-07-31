import './appIdentity'
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

// getSettings is on the hot path (every selection/mouse event reads it), and
// normalizeSettings does a full defaults merge — cache the normalized result
// and invalidate only when the store is written.
let cachedSettings: AppSettings | null = null

export function getSettings(): AppSettings {
  if (!cachedSettings) cachedSettings = normalizeSettings(store.get('settings'))
  return cachedSettings
}

export function updateSettings(patch: SettingsPatch): AppSettings {
  const next = mergeSettings(getSettings(), patch)
  store.set('settings', next)
  cachedSettings = next
  listeners.forEach((listener) => listener(next))
  return next
}

export function onSettingsChanged(listener: (settings: AppSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
