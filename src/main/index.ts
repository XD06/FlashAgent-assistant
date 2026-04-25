import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildAssistantSystemPrompt } from '@shared/actions'
import { IPC } from '@shared/ipc'
import { APP_ICON_DATA_URL, APP_TRAY_DATA_URL } from '@shared/brand'
import type { AiStreamRequest, SettingsPatch } from '@shared/types'
import { listModels, streamChatCompletion, testModel } from './ai/OpenAICompatibleClient'
import { SelectionService } from './SelectionService'
import { getSettings, onSettingsChanged, updateSettings } from './settingsStore'
import { isSupportedPlatform, isWin } from './platform'

const __dirname = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(__dirname, '../preload/index.mjs')
const rendererDir = join(__dirname, '../renderer')

if (isWin) app.commandLine.appendSwitch('wm-window-animations-disabled')

let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
const abortControllers = new Map<string, AbortController>()

const selectionService = new SelectionService(getSettings, preloadPath, rendererDir)
const appIcon = nativeImage.createFromDataURL(APP_ICON_DATA_URL)
const trayIcon = nativeImage.createFromDataURL(APP_TRAY_DATA_URL)

function getTrayIcon(): Electron.NativeImage {
  return trayIcon.resize({ width: 18, height: 18 })
}

function mainText(key: 'enable' | 'disable' | 'settings' | 'quit', language: string): string {
  const zh = {
    enable: '启用AIA划词助手',
    disable: '停用AIA划词助手',
    settings: '设置',
    quit: '退出'
  }
  const en = {
    enable: 'Enable AIA Selection Assistant',
    disable: 'Disable AIA Selection Assistant',
    settings: 'Settings',
    quit: 'Quit'
  }
  return (language === 'zh-CN' ? zh : en)[key]
}

function loadRenderer(win: BrowserWindow, page: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`)
  } else {
    void win.loadFile(join(rendererDir, page))
  }
}

function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    app.dock?.show()
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 560,
    icon: appIcon,
    title: 'AIA划词助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  settingsWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    settingsWindow?.hide()
    app.dock?.hide()
  })
  settingsWindow.on('show', () => app.dock?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  loadRenderer(settingsWindow, 'settings.html')
  return settingsWindow
}

function createTray(): void {
  tray = new Tray(getTrayIcon())
  tray.setToolTip('AIA划词助手')
  tray.on('click', () => createSettingsWindow())
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: settings.enabled ? mainText('disable', settings.language) : mainText('enable', settings.language),
        enabled: isSupportedPlatform && selectionService.isAvailable,
        click: () => {
          const next = updateSettings({ enabled: !getSettings().enabled })
          applySelectionState(next)
        }
      },
      { label: mainText('settings', settings.language), click: () => createSettingsWindow() },
      { type: 'separator' },
      {
        label: mainText('quit', settings.language),
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function registerShortcuts(): void {
  const settings = getSettings()
  globalShortcut.unregisterAll()
  const shortcuts = [
    {
      accelerator: settings.shortcuts.toggleAssistant,
      action: () => {
        const next = updateSettings({ enabled: !getSettings().enabled })
        applySelectionState(next)
      }
    },
    {
      accelerator: settings.shortcuts.processSelection,
      action: () => {
        selectionService.processShortcutSelection()
      }
    }
  ]

  for (const shortcut of shortcuts) {
    const accelerator = shortcut.accelerator.trim()
    if (!accelerator) continue
    const registered = globalShortcut.register(accelerator, shortcut.action)
    if (!registered) console.warn(`Failed to register global shortcut: ${accelerator}`)
  }
}

function applySelectionState(settings = getSettings()): void {
  if (!isSupportedPlatform || !selectionService.isAvailable) return
  if (settings.enabled && !selectionService.isRunning) {
    selectionService.start()
  } else if (!settings.enabled && selectionService.isRunning) {
    selectionService.stop()
  } else if (selectionService.isRunning) {
    selectionService.applySettings(settings)
  }
  refreshTrayMenu()
}

function registerIpc(): void {
  selectionService.registerIpc()

  ipcMain.handle(IPC.SettingsGet, () => getSettings())
  ipcMain.handle(IPC.SettingsUpdate, (_event, patch: SettingsPatch) => {
    const settings = updateSettings(patch)
    registerShortcuts()
    applySelectionState(settings)
    return settings
  })
  ipcMain.handle(IPC.OpenExternal, (_event, url: string) => shell.openExternal(url))

  ipcMain.handle(IPC.AiStream, async (event, request: AiStreamRequest) => {
    const controller = new AbortController()
    const settings = getSettings()
    abortControllers.set(request.requestId, controller)
    try {
      await streamChatCompletion(settings.provider, request.prompt, buildAssistantSystemPrompt(settings), controller.signal, (delta) => {
        event.sender.send(IPC.AiChunk, { requestId: request.requestId, type: 'delta', text: delta })
      })
      event.sender.send(IPC.AiChunk, { requestId: request.requestId, type: 'done' })
    } catch (error) {
      if (controller.signal.aborted) {
        event.sender.send(IPC.AiChunk, { requestId: request.requestId, type: 'done' })
      } else {
        event.sender.send(IPC.AiChunk, {
          requestId: request.requestId,
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      abortControllers.delete(request.requestId)
    }
  })

  ipcMain.handle(IPC.AiAbort, (_event, requestId: string) => {
    abortControllers.get(requestId)?.abort()
    abortControllers.delete(requestId)
  })
  ipcMain.handle(IPC.AiListModels, () => listModels(getSettings().provider))
  ipcMain.handle(IPC.AiTestModel, async () => {
    await testModel(getSettings().provider)
    return { ok: true }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.selectionassistant.lite')
    app.dock?.setIcon(appIcon)
    app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))

    registerIpc()
    createTray()
    registerShortcuts()
    applySelectionState()

    onSettingsChanged((settings) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.SettingsChanged, settings)
      }
      refreshTrayMenu()
    })

    createSettingsWindow()
  })

  app.on('second-instance', () => createSettingsWindow())
  app.on('activate', () => createSettingsWindow())
  app.on('will-quit', () => {
    isQuitting = true
    globalShortcut.unregisterAll()
    selectionService.dispose()
  })
}
