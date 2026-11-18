import { useEffect, useState } from 'react'
import { defaultSettings } from '@shared/defaults'
import type { AppSettings, SettingsPatch } from '@shared/types'

export function useSettings() {
  const [initial] = useState<AppSettings | null>(() => {
    try {
      return window.assistantLite?.settings?.getSync?.() ?? null
    } catch {
      return null
    }
  })
  const [settings, setSettings] = useState<AppSettings>(initial ?? defaultSettings)
  const [loaded, setLoaded] = useState(initial !== null)

  useEffect(() => {
    let alive = true
    if (initial === null) {
      void window.assistantLite.settings.get().then((value) => {
        if (alive) {
          setSettings(value)
          setLoaded(true)
        }
      })
    }
    const off = window.assistantLite.settings.onChanged(setSettings)
    return () => {
      alive = false
      off()
    }
  }, [initial])

  const update = async (patch: SettingsPatch) => {
    const next = await window.assistantLite.settings.update(patch)
    setSettings(next)
    return next
  }

  return { settings, loaded, update }
}
