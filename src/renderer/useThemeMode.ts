import { useEffect, useState } from 'react'
import { defaultPrimaryColor } from '@shared/defaults'
import { deriveThemeCssVars, type ResolvedThemeMode } from '@shared/theme'
import type { ChatColorMode, ColorStyle, ThemeMode } from '@shared/types'

export type ThemeModeInput =
  | ThemeMode
  | {
      theme: ThemeMode
      pureBlack?: boolean
      primaryColor?: string | null
      colorStyle?: ColorStyle
      chatColorMode?: ChatColorMode
    }

function resolveTheme(theme: ThemeMode): ResolvedThemeMode {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useSystemAccentColor(): string {
  const [systemAccent, setSystemAccent] = useState(defaultPrimaryColor)

  useEffect(() => {
    const appApi = window.assistantLite?.app
    if (!appApi?.getSystemAccentColor) return
    let active = true
    void appApi
      .getSystemAccentColor()
      .then((color) => {
        if (active && color) setSystemAccent(color)
      })
      .catch(() => {})
    const off = appApi.onSystemAccentColorChanged?.((color) => {
      if (color) setSystemAccent(color)
    })
    return () => {
      active = false
      off?.()
    }
  }, [])

  return systemAccent
}

export function useThemeMode(input: ThemeModeInput) {
  const themeMode = typeof input === 'string' ? input : input.theme
  const pureBlack = typeof input === 'string' ? false : Boolean(input.pureBlack)
  const primaryColor = typeof input === 'string' ? defaultPrimaryColor : (input.primaryColor === undefined ? defaultPrimaryColor : input.primaryColor)
  const colorStyle: ColorStyle = typeof input === 'string' ? 'vivid' : (input.colorStyle ?? 'vivid')
  const chatColorMode: ChatColorMode = typeof input === 'string' ? 'semantic' : (input.chatColorMode ?? 'semantic')

  const systemAccent = useSystemAccentColor()

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const root = document.documentElement

    const syncTheme = () => {
      const resolved = resolveTheme(themeMode)
      root.dataset.theme = resolved
      root.dataset.chatColor = colorStyle === 'monochrome' ? 'minimal' : chatColorMode
      root.style.colorScheme = resolved
      const vars = deriveThemeCssVars({ pureBlack, primaryColor, colorStyle }, resolved, systemAccent)
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value)
      }
    }

    syncTheme()
    if (themeMode !== 'system') return

    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [themeMode, pureBlack, primaryColor, colorStyle, chatColorMode, systemAccent])
}
