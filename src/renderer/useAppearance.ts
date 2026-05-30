import { useEffect } from 'react'
import type { AppSettings } from '@shared/types'

// Push the user's font preferences into CSS variables that styles.css reads
// (--app-font for the family, --app-font-size for result/input text).
export function useAppearance(settings: Pick<AppSettings, 'fontFamily' | 'fontSize'>): void {
  useEffect(() => {
    const root = document.documentElement
    const family = settings.fontFamily.trim()
    if (family) root.style.setProperty('--app-font', `${family}, ui-sans-serif, system-ui, sans-serif`)
    else root.style.removeProperty('--app-font')
    root.style.setProperty('--app-font-size', `${settings.fontSize}px`)
  }, [settings.fontFamily, settings.fontSize])
}
