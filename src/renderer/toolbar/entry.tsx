import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { buildSearchUrl } from '@shared/actions'
import { APP_ICON_SVG } from '@shared/brand'
import type { ActionItem, SelectedTextPayload } from '@shared/types'
import { Icon } from '../icons'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { getActionLabel } from '../i18n'

function ToolbarApp() {
  const { settings } = useSettings()
  const [selection, setSelection] = React.useState<SelectedTextPayload | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  useThemeMode(settings.theme)

  React.useEffect(() => {
    document.documentElement.classList.add('toolbar-page-root')
    document.body.classList.add('toolbar-page')
    return () => {
      document.documentElement.classList.remove('toolbar-page-root')
      document.body.classList.remove('toolbar-page')
    }
  }, [])

  React.useEffect(() => window.assistantLite.selection.onSelected(setSelection), [])
  React.useEffect(() => {
    const width = rootRef.current?.getBoundingClientRect().width ?? 0
    if (width > 0) void window.assistantLite.selection.determineToolbarSize(width)
  }, [settings.compactToolbar, settings.showToolbarAppIcon, settings.actions])

  const enabledActions = settings.actions.filter((action) => action.enabled)

  const handleAction = async (action: ActionItem) => {
    const selectedText = selection?.text ?? ''
    if (!selectedText) return

    if (action.type === 'copy') {
      await window.assistantLite.selection.writeClipboard(selectedText)
      return
    }

    if (action.type === 'search') {
      const url = buildSearchUrl(action, selectedText)
      if (url) await window.assistantLite.app.openExternal(url)
      await window.assistantLite.selection.hideToolbar()
      return
    }

    await window.assistantLite.selection.processAction({
      action,
      selectedText,
      isFullscreen: selection?.isFullscreen
    })
    await window.assistantLite.selection.hideToolbar()
  }

  return (
    <div className="toolbar-root" ref={rootRef}>
      {settings.showToolbarAppIcon && <div className="toolbar-logo" dangerouslySetInnerHTML={{ __html: APP_ICON_SVG }} />}
      {enabledActions.map((action) => (
        <button
          className="toolbar-button"
          key={action.id}
          title={getActionLabel(action, settings.language)}
          onClick={() => void handleAction(action)}>
          <Icon name={action.icon} />
          {!settings.compactToolbar && <span>{getActionLabel(action, settings.language)}</span>}
        </button>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToolbarApp />
  </React.StrictMode>
)
