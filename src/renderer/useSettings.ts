import { useEffect, useState } from 'react'
import { defaultSettings } from '@shared/defaults'
import type { AppSettings, SettingsPatch } from '@shared/types'

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void window.assistantLite.settings.get().then((value) => {
      if (alive) {
        setSettings(value)
        setLoaded(true)
      }
    })
    const off = window.assistantLite.settings.onChanged(setSettings)
    return () => {
      alive = false
      off()
    }
  }, [])

  const update = async (patch: SettingsPatch) => {
    const next = await window.assistantLite.settings.update(patch)
    setSettings(next)
    return next
  }

  return { settings, loaded, update }
}
