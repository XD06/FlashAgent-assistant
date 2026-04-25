import { useEffect } from 'react'
import type { ThemeMode } from '@shared/types'

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyResolvedTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function useThemeMode(themeMode: ThemeMode) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => applyResolvedTheme(resolveTheme(themeMode))

    syncTheme()
    if (themeMode !== 'system') return

    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [themeMode])
}
