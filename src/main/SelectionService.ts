import { BrowserWindow, clipboard, ipcMain, screen, systemPreferences } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { shouldProcessProgram } from '@shared/selectionFilter'
import type { ActionItem, ActionPayload, AppSettings, SelectedTextPayload } from '@shared/types'
import { isMac, isWin } from './platform'
import type {
  KeyboardEventData,
  MouseEventData,
  SelectionHookConstructor,
  SelectionHookInstance,
  TextSelectionData
} from 'selection-hook'

const require = createRequire(import.meta.url)

type Point = { x: number; y: number }
type Orientation = 'topLeft' | 'topRight' | 'topMiddle' | 'bottomLeft' | 'bottomRight' | 'bottomMiddle'

const TOOLBAR_HEIGHT = 36
const DEFAULT_TOOLBAR_WIDTH = 390
const TOOLBAR_SCREEN_MARGIN = 8
const TOOLBAR_SHADOW_PADDING = 16
const ACTION_WIDTH = 560
const ACTION_HEIGHT = 420
const ACTION_SHADOW_PADDING = 18

export class SelectionService {
  private hookCtor: SelectionHookConstructor | null = null
  private hook: SelectionHookInstance | null = null
  private toolbarWindow: BrowserWindow | null = null
  private actionWindows = new Set<BrowserWindow>()
  // Payload a fresh action window opens with, keyed by webContents id. The
  // renderer pulls it synchronously on its first render (SelectionGetInitialAction).
  private pendingInitialPayload = new Map<number, ActionPayload>()
  private started = false
  private toolbarWidth = DEFAULT_TOOLBAR_WIDTH
  private lastActionSize = { width: ACTION_WIDTH, height: ACTION_HEIGHT }
  private hideListenerActive = false

  constructor(
    private getSettings: () => AppSettings,
    private preloadPath: string,
    private rendererDir: string,
    private windowIcon: Electron.NativeImage
  ) {
    try {
      this.hookCtor = require('selection-hook') as SelectionHookConstructor
      this.hook = new this.hookCtor()
    } catch (error) {
      console.error('Failed to load selection-hook', error)
    }
  }

  get isAvailable(): boolean {
    return !!this.hook && !!this.hookCtor
  }

  get isRunning(): boolean {
    return this.started
  }

  start(): boolean {
    if (!this.hook || !this.hookCtor || this.started) return false
    if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) return false

    this.createToolbarWindow()
    this.hook.on('text-selection', this.handleSelection)

    if (!this.hook.start({ debug: !process.env.NODE_ENV || process.env.NODE_ENV === 'development' })) return false

    this.started = true
    this.applySettings(this.getSettings())
    return true
  }

  stop(): void {
    if (!this.hook || !this.started) return
    this.stopHideListeners()
    this.hook.stop()
    this.hook.cleanup()
    this.toolbarWindow?.close()
    this.toolbarWindow = null
    for (const win of this.actionWindows) {
      if (!win.isDestroyed()) win.close()
    }
    this.actionWindows.clear()
    this.started = false
  }

  dispose(): void {
    this.stop()
    this.hook = null
  }

  applySettings(settings: AppSettings): void {
    if (!this.hook || !this.hookCtor || !this.started) return

    const modeMap = {
      default: this.hookCtor.FilterMode.DEFAULT,
      whitelist: this.hookCtor.FilterMode.INCLUDE_LIST,
      blacklist: this.hookCtor.FilterMode.EXCLUDE_LIST
    }
    this.hook.setGlobalFilterMode(modeMap[settings.filterMode], settings.filterList)

    this.hook.setSelectionPassiveMode(settings.triggerMode === 'shortcut')
  }

  processShortcutSelection(): void {
    if (!this.hook || !this.started || this.getSettings().triggerMode !== 'shortcut') return
    const selection = this.hook.getCurrentSelection()
    if (selection) this.handleSelection(selection)
  }

  hideToolbar(): void {
    this.stopHideListeners()
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    this.toolbarWindow.hide()
    this.toolbarWindow.webContents.send(IPC.SelectionVisibility, false)
  }

  writeClipboard(text: string): boolean {
    if (this.hook && this.started) {
      try {
        return this.hook.writeToClipboard(text)
      } catch {
        // Fall through to Electron clipboard.
      }
    }
    clipboard.writeText(text)
    return true
  }

  setToolbarSize(width: number): void {
    if (!Number.isFinite(width) || width <= 0) return
    this.toolbarWidth = this.clampToolbarWidth(Math.ceil(width))
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed() || !this.toolbarWindow.isVisible()) return

    const bounds = this.toolbarWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea
    const visibleX = bounds.x + TOOLBAR_SHADOW_PADDING
    const x = Math.round(Math.max(area.x, Math.min(visibleX, area.x + area.width - this.toolbarWidth)))
    this.toolbarWindow.setBounds({
      x: x - TOOLBAR_SHADOW_PADDING,
      y: bounds.y,
      width: this.getToolbarWindowWidth(),
      height: this.getToolbarWindowHeight()
    })
  }

  processAction(payload: ActionPayload): void {
    const settings = this.getSettings()
    this.openActionWindow(payload, (win) => this.positionAndShowActionWindow(win, settings))
  }

  // Open a type-in window for an action (triggered by its global shortcut),
  // independent of the selection toolbar.
  openActionInput(action: ActionItem): void {
    const settings = this.getSettings()
    const payload: ActionPayload = { action, selectedText: '', mode: 'input' }
    this.openActionWindow(payload, (win) => {
      this.positionActionWindowCenter(win, settings)
      win.show()
      win.focus()
    })
  }

  // A visible window is already mounted: hand it the new payload and re-show it.
  // A fresh window stashes its payload for the renderer to pull on first render,
  // and is shown only once its first frame is painted (ready-to-show) — so it
  // appears once, already populated, instead of flashing empty then filling in.
  private openActionWindow(payload: ActionPayload, show: (win: BrowserWindow) => void): void {
    const existing = Array.from(this.actionWindows).find((win) => !win.isDestroyed() && win.isVisible())
    if (existing) {
      existing.webContents.send(IPC.SelectionProcessAction, payload)
      show(existing)
      return
    }
    const win = this.createActionWindow()
    this.pendingInitialPayload.set(win.webContents.id, payload)
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) show(win)
    })
  }

  closeActionWindow(sender: Electron.WebContents): void {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) win.close()
  }

  minimizeActionWindow(sender: Electron.WebContents): void {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) win.minimize()
  }

  pinActionWindow(sender: Electron.WebContents, pinned: boolean): void {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned)
  }

  registerIpc(): void {
    ipcMain.handle(IPC.SelectionStart, () => this.start())
    ipcMain.handle(IPC.SelectionStop, () => this.stop())
    ipcMain.handle(IPC.SelectionHideToolbar, () => this.hideToolbar())
    ipcMain.handle(IPC.SelectionWriteClipboard, (_event, text: string) => this.writeClipboard(text))
    ipcMain.handle(IPC.SelectionDetermineToolbarSize, (_event, width: number) => this.setToolbarSize(width))
    ipcMain.handle(IPC.SelectionProcessAction, (_event, payload: ActionPayload) => this.processAction(payload))
    ipcMain.on(IPC.SelectionGetInitialAction, (event) => {
      const payload = this.pendingInitialPayload.get(event.sender.id) ?? null
      this.pendingInitialPayload.delete(event.sender.id)
      event.returnValue = payload
    })
    ipcMain.handle(IPC.WindowClose, (event) => this.closeActionWindow(event.sender))
    ipcMain.handle(IPC.WindowMinimize, (event) => this.minimizeActionWindow(event.sender))
    ipcMain.handle(IPC.WindowPin, (event, pinned: boolean) => this.pinActionWindow(event.sender, pinned))
    ipcMain.handle(IPC.SelectionGetAccessibility, () =>
      isMac ? systemPreferences.isTrustedAccessibilityClient(false) : true
    )
    ipcMain.handle(IPC.SelectionRequestAccessibility, () =>
      isMac ? systemPreferences.isTrustedAccessibilityClient(true) : true
    )
  }

  private createToolbarWindow(): void {
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) return

    this.toolbarWindow = new BrowserWindow({
      width: this.getToolbarWindowWidth(),
      height: this.getToolbarWindowHeight(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      autoHideMenuBar: true,
      focusable: false,
      ...(isMac ? { type: 'panel' as const, hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (isMac) {
      this.toolbarWindow.on('blur', () => this.hideToolbar())
    }
    this.toolbarWindow.on('closed', () => {
      this.toolbarWindow = null
    })
    this.loadRenderer(this.toolbarWindow, 'selectionToolbar.html')
  }

  private createActionWindow(): BrowserWindow {
    const settings = this.getSettings()
    const width = settings.rememberWindowSize ? this.lastActionSize.width : settings.actionWindowWidth
    const height = settings.rememberWindowSize ? this.lastActionSize.height : settings.actionWindowHeight
    const win = new BrowserWindow({
      width: this.getActionWindowWidth(width),
      height: this.getActionWindowHeight(height),
      minWidth: this.getActionWindowWidth(320),
      minHeight: this.getActionWindowHeight(240),
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      icon: this.windowIcon,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: ACTION_SHADOW_PADDING + 12, y: ACTION_SHADOW_PADDING + 10 },
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    const wcId = win.webContents.id
    win.on('closed', () => {
      this.actionWindows.delete(win)
      this.pendingInitialPayload.delete(wcId)
    })
    win.on('resized', () => {
      if (this.getSettings().rememberWindowSize && !win.isDestroyed()) {
        const bounds = win.getBounds()
        this.lastActionSize = {
          width: Math.max(320, bounds.width - ACTION_SHADOW_PADDING * 2),
          height: Math.max(240, bounds.height - ACTION_SHADOW_PADDING * 2)
        }
      }
    })
    this.actionWindows.add(win)
    this.loadRenderer(win, 'selectionAction.html')
    return win
  }

  private loadRenderer(win: BrowserWindow, page: string): void {
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`)
    } else {
      void win.loadFile(join(this.rendererDir, page))
    }
  }

  private handleSelection = (selection: TextSelectionData): void => {
    const text = selection.text?.trim()
    if (!text) return
    const settings = this.getSettings()
    if (!settings.enabled || !shouldProcessProgram(selection.programName, settings.filterMode, settings.filterList)) {
      return
    }
    if (this.toolbarWindow?.isVisible()) return

    this.createToolbarWindow()
    const { point, orientation } = this.resolveSelectionAnchor(selection)
    this.showToolbar(point, orientation, {
      text,
      programName: selection.programName,
      isFullscreen: selection.isFullscreen
    })
  }

  private resolveSelectionAnchor(selection: TextSelectionData): { point: Point; orientation: Orientation } {
    const positionLevel = this.hookCtor?.PositionLevel
    let point: Point = screen.getCursorScreenPoint()
    let orientation: Orientation = 'bottomMiddle'
    let isLogical = true

    if (positionLevel && selection.posLevel === positionLevel.MOUSE_SINGLE) {
      point = { x: selection.mousePosEnd.x, y: selection.mousePosEnd.y + 16 }
      isLogical = false
    } else if (positionLevel && selection.posLevel === positionLevel.MOUSE_DUAL) {
      const yDistance = selection.mousePosEnd.y - selection.mousePosStart.y
      const xDistance = selection.mousePosEnd.x - selection.mousePosStart.x
      if (Math.abs(yDistance) > 14) {
        orientation = yDistance > 0 ? 'bottomLeft' : 'topRight'
        point = { x: selection.mousePosEnd.x, y: selection.mousePosEnd.y + (yDistance > 0 ? 16 : -16) }
      } else {
        orientation = xDistance > 0 ? 'bottomLeft' : 'bottomRight'
        point = { x: selection.mousePosEnd.x, y: Math.max(selection.mousePosEnd.y, selection.mousePosStart.y) + 16 }
      }
      isLogical = false
    } else if (
      positionLevel &&
      (selection.posLevel === positionLevel.SEL_FULL || selection.posLevel === positionLevel.SEL_DETAILED)
    ) {
      const sameLine =
        selection.startTop.y === selection.endTop.y && selection.startBottom.y === selection.endBottom.y
      const mouseDirectionY = selection.mousePosEnd.y - selection.mousePosStart.y
      if (sameLine) {
        const direction = selection.mousePosEnd.x - selection.mousePosStart.x
        orientation = direction >= 0 ? 'bottomLeft' : 'bottomRight'
        point = direction >= 0 ? selection.endBottom : selection.startBottom
      } else {
        orientation = mouseDirectionY >= 0 ? 'bottomLeft' : 'topRight'
        point = mouseDirectionY >= 0 ? selection.endBottom : selection.startTop
      }
      point = { x: point.x, y: point.y + (orientation === 'topRight' ? -4 : 4) }
      isLogical = false
    }

    if (!isLogical && isWin) point = screen.screenToDipPoint(point)
    return { point: { x: Math.round(point.x), y: Math.round(point.y) }, orientation }
  }

  private showToolbar(anchor: Point, orientation: Orientation, payload: SelectedTextPayload): void {
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    const position = this.calculateToolbarPosition(anchor, orientation)
    this.toolbarWindow.setBounds({
      x: position.x - TOOLBAR_SHADOW_PADDING,
      y: position.y - TOOLBAR_SHADOW_PADDING,
      width: this.getToolbarWindowWidth(),
      height: this.getToolbarWindowHeight()
    })
    this.toolbarWindow.setAlwaysOnTop(true, 'screen-saver')
    this.toolbarWindow.webContents.send(IPC.SelectionSelected, payload)
    this.toolbarWindow.webContents.send(IPC.SelectionVisibility, true)
    if (isMac || isWin) {
      this.toolbarWindow.showInactive()
    } else {
      this.toolbarWindow.show()
    }
    this.startHideListeners()
  }

  private calculateToolbarPosition(anchor: Point, orientation: Orientation): Point {
    const display = screen.getDisplayNearestPoint(anchor)
    const area = display.workArea
    this.toolbarWidth = this.clampToolbarWidthForArea(this.toolbarWidth, area.width)
    let x = anchor.x - this.toolbarWidth / 2
    let y = anchor.y

    if (orientation === 'topLeft') {
      x = anchor.x - this.toolbarWidth
      y = anchor.y - TOOLBAR_HEIGHT
    } else if (orientation === 'topRight') {
      x = anchor.x
      y = anchor.y - TOOLBAR_HEIGHT
    } else if (orientation === 'topMiddle') {
      y = anchor.y - TOOLBAR_HEIGHT
    } else if (orientation === 'bottomLeft') {
      x = anchor.x - this.toolbarWidth
    } else if (orientation === 'bottomRight') {
      x = anchor.x
    }

    return {
      x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - this.toolbarWidth))),
      y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - TOOLBAR_HEIGHT)))
    }
  }

  private clampToolbarWidth(width: number): number {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return this.clampToolbarWidthForArea(width, display.workArea.width)
  }

  private clampToolbarWidthForArea(width: number, areaWidth: number): number {
    const maxWidth = Math.max(120, areaWidth - TOOLBAR_SCREEN_MARGIN * 2)
    return Math.min(width, maxWidth)
  }

  private getToolbarWindowWidth(): number {
    return this.toolbarWidth + TOOLBAR_SHADOW_PADDING * 2
  }

  private getToolbarWindowHeight(): number {
    return TOOLBAR_HEIGHT + TOOLBAR_SHADOW_PADDING * 2
  }

  private getActionWindowWidth(width: number): number {
    return width + ACTION_SHADOW_PADDING * 2
  }

  private getActionWindowHeight(height: number): number {
    return height + ACTION_SHADOW_PADDING * 2
  }

  private positionAndShowActionWindow(win: BrowserWindow, settings: AppSettings): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = settings.rememberWindowSize ? this.lastActionSize.width : settings.actionWindowWidth
    const height = settings.rememberWindowSize ? this.lastActionSize.height : settings.actionWindowHeight
    let x = Math.round(area.x + (area.width - width) / 2)
    let y = Math.round(area.y + (area.height - height) / 2)

    if (settings.followToolbar && this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      const toolbar = this.toolbarWindow.getBounds()
      x = Math.round(toolbar.x + TOOLBAR_SHADOW_PADDING + (this.toolbarWidth - width) / 2)
      y = Math.round(toolbar.y + TOOLBAR_SHADOW_PADDING + TOOLBAR_HEIGHT + 8)
      x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8))
      y = Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8))
    }

    win.setBounds({
      x: x - ACTION_SHADOW_PADDING,
      y: y - ACTION_SHADOW_PADDING,
      width: this.getActionWindowWidth(width),
      height: this.getActionWindowHeight(height)
    })
    if (settings.autoPin) win.setAlwaysOnTop(true)
    if (isMac && settings.autoPin) win.showInactive()
    else win.show()
  }

  private positionActionWindowCenter(win: BrowserWindow, settings: AppSettings): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = settings.rememberWindowSize ? this.lastActionSize.width : settings.actionWindowWidth
    const height = settings.rememberWindowSize ? this.lastActionSize.height : settings.actionWindowHeight
    const x = Math.round(area.x + (area.width - width) / 2)
    const y = Math.round(area.y + (area.height - height) / 2)
    win.setBounds({
      x: x - ACTION_SHADOW_PADDING,
      y: y - ACTION_SHADOW_PADDING,
      width: this.getActionWindowWidth(width),
      height: this.getActionWindowHeight(height)
    })
    if (settings.autoPin) win.setAlwaysOnTop(true)
  }

  private startHideListeners(): void {
    if (!this.hook || this.hideListenerActive) return
    this.hook.on('mouse-down', this.handleMouseDownHide)
    this.hook.on('mouse-wheel', this.handleHide)
    this.hook.on('key-down', this.handleKeyDownHide)
    this.hideListenerActive = true
  }

  private stopHideListeners(): void {
    if (!this.hook || !this.hideListenerActive) return
    this.hook.off('mouse-down', this.handleMouseDownHide)
    this.hook.off('mouse-wheel', this.handleHide)
    this.hook.off('key-down', this.handleKeyDownHide)
    this.hideListenerActive = false
  }

  private handleHide = (): void => this.hideToolbar()

  private handleMouseDownHide = (event: MouseEventData): void => {
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    const point = isWin ? screen.screenToDipPoint({ x: event.x, y: event.y }) : { x: event.x, y: event.y }
    const bounds = this.toolbarWindow.getBounds()
    const inside =
      point.x >= bounds.x + TOOLBAR_SHADOW_PADDING &&
      point.x <= bounds.x + TOOLBAR_SHADOW_PADDING + this.toolbarWidth &&
      point.y >= bounds.y + TOOLBAR_SHADOW_PADDING &&
      point.y <= bounds.y + TOOLBAR_SHADOW_PADDING + TOOLBAR_HEIGHT
    if (!inside) this.hideToolbar()
  }

  private handleKeyDownHide = (event: KeyboardEventData): void => {
    if (this.isModifierKey(event.vkCode)) return
    this.hideToolbar()
  }

  private isModifierKey(vkCode: number): boolean {
    return this.isCtrlKey(vkCode) || this.isShiftKey(vkCode) || this.isAltKey(vkCode)
  }

  private isCtrlKey(vkCode: number): boolean {
    return isMac ? vkCode === 59 || vkCode === 62 : vkCode === 162 || vkCode === 163
  }

  private isShiftKey(vkCode: number): boolean {
    return isMac ? vkCode === 56 || vkCode === 60 : vkCode === 160 || vkCode === 161
  }

  private isAltKey(vkCode: number): boolean {
    return isMac ? vkCode === 58 || vkCode === 61 : vkCode === 164 || vkCode === 165
  }
}
