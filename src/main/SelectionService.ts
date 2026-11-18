import { BrowserWindow, clipboard, ipcMain, screen, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { shouldProcessProgram } from '@shared/selectionFilter'
import type { ActionItem, ActionPayload, AppSettings, SelectedTextPayload } from '@shared/types'
import { isMac, isWin } from './platform'
import { hasActiveStream } from './activeStreams'
import {
  cascadeWindowOrigin,
  hasUsableSelectionRect,
  isPointInsideToolbarHitbox,
  isValidSelectionPoint,
  pickReusableSubWindow,
  resolveLiveActionItem
} from './selectionWindowPolicy'
import type {
  KeyboardEventData,
  MouseEventData,
  SelectionHookConstructor,
  SelectionHookInstance,
  TextSelectionData
} from 'selection-hook'

type Point = { x: number; y: number }
type Orientation = 'topLeft' | 'topRight' | 'topMiddle' | 'bottomLeft' | 'bottomRight' | 'bottomMiddle'

const TOOLBAR_HEIGHT = 36
const DEFAULT_TOOLBAR_WIDTH = 390
const TOOLBAR_SCREEN_MARGIN = 8
const TOOLBAR_SHADOW_PADDING = 16
const ACTION_WIDTH = 560
const ACTION_HEIGHT = 420
const ACTION_SHADOW_PADDING = 0
// A hidden action/chat window still holds its renderer (tens of MB plus chat
// DOM). Same trade-off as the settings window: keep close-to-hide instant
// reopen, destroy the renderer after 60s hidden.
const ACTION_IDLE_DESTROY_MS = 60_000

// selection-hook ships a "clipboard fallback" that simulates Ctrl+Insert then
// Ctrl+C when UIA/IAccessible can't read the selection. Simulated copies are
// destructive: Ctrl+C kills CLIs in terminals, fires clipboard managers on
// every double-click/long-press, and pollutes clipboard history. We disable
// the fallback entirely and rely on the non-invasive accessibility APIs only;
// the rare app exposing neither simply won't trigger the toolbar.

export class SelectionService {
  private hookCtor: SelectionHookConstructor | null = null
  private hook: SelectionHookInstance | null = null
  private toolbarWindow: BrowserWindow | null = null
  private actionWindows = new Set<BrowserWindow>()
  // Payload a fresh action window opens with, keyed by webContents id. The
  // renderer pulls it synchronously on its first render (SelectionGetInitialAction).
  private pendingInitialPayload = new Map<number, ActionPayload>()
  // Latest selection handed to the toolbar so cold loads pull it synchronously
  // without losing an IPC push before selectionToolbar.html attaches listeners.
  private pendingInitialSelection: SelectedTextPayload | null = null
  private pendingToolbarShow: { anchor: Point; orientation: Orientation; payload: SelectedTextPayload } | null = null
  private toolbarReady = false
  private toolbarShowFallbackTimer: NodeJS.Timeout | null = null
  private toolbarPointerDownActive = false
  private toolbarPointerDownTimer: NodeJS.Timeout | null = null
  private started = false
  private toolbarIdleTimer: NodeJS.Timeout | null = null
  private toolbarWidth = DEFAULT_TOOLBAR_WIDTH
  // Hidden action windows keep their renderer (≈ settings-window pattern:
  // instant reopen, idle destroy). One timer per hidden window.
  private actionIdleTimers = new Map<BrowserWindow, NodeJS.Timeout>()
  // True once dispose() runs (app quit): close events must proceed to destroy
  // instead of hide, otherwise quit would hang on a prevented close.
  private quitting = false
  private lastActionSize = { width: 0, height: 0 } // lazily initialized from settings
  private hideListenerActive = false

  constructor(
    private getSettings: () => AppSettings,
    private updateSettings: (patch: Partial<AppSettings>) => AppSettings,
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

    // start/stop cycles (and a failed native start below) must not stack
    // duplicate handlers — stop() does not remove this subscription.
    this.hook.off('text-selection', this.handleSelection)
    this.hook.on('text-selection', this.handleSelection)

    if (
      !this.hook.start({
        debug: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
        enableClipboard: false
      })
    ) {
      return false
    }

    this.started = true
    this.applySettings(this.getSettings())
    return true
  }

  stop(): void {
    if (!this.hook || !this.started) return
    this.stopHideListeners()
    this.clearToolbarIdleTimer()
    this.clearToolbarShowFallbackTimer()
    this.clearToolbarPointerDownState()
    this.pendingToolbarShow = null
    this.pendingInitialSelection = null
    this.toolbarReady = false
    this.hook.stop()
    this.hook.cleanup()
    this.toolbarWindow?.close()
    this.toolbarWindow = null
    for (const win of this.actionWindows) {
      // destroy() bypasses the 'close' handler (which hides for reuse) —
      // disabling the feature must release renderers, not park them hidden.
      if (!win.isDestroyed()) win.destroy()
    }
    for (const timer of this.actionIdleTimers.values()) clearTimeout(timer)
    this.actionIdleTimers.clear()
    this.actionWindows.clear()
    this.started = false
  }

  dispose(): void {
    this.quitting = true
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
    if (selection) this.handleSelection(selection, true)
  }

  hideToolbar(): void {
    this.stopHideListeners()
    this.clearToolbarShowFallbackTimer()
    this.clearToolbarPointerDownState()
    this.pendingToolbarShow = null
    this.pendingInitialSelection = null
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    if (this.toolbarWindow.isVisible()) {
      this.toolbarWindow.hide()
      this.toolbarWindow.webContents.send(IPC.SelectionVisibility, false)
    }
    this.scheduleToolbarIdleDestroy()
  }

  private clearToolbarShowFallbackTimer(): void {
    if (this.toolbarShowFallbackTimer) {
      clearTimeout(this.toolbarShowFallbackTimer)
      this.toolbarShowFallbackTimer = null
    }
  }

  private clearToolbarPointerDownState(): void {
    this.toolbarPointerDownActive = false
    if (this.toolbarPointerDownTimer) {
      clearTimeout(this.toolbarPointerDownTimer)
      this.toolbarPointerDownTimer = null
    }
  }

  private markToolbarPointerDown(): void {
    this.clearToolbarPointerDownState()
    this.toolbarPointerDownActive = true
    this.toolbarPointerDownTimer = setTimeout(() => {
      this.toolbarPointerDownTimer = null
      this.toolbarPointerDownActive = false
    }, 1500)
  }

  // A hidden toolbar still holds a renderer process (~30-60MB). Destroy it
  // after 30s of inactivity; the next selection recreates it lazily.
  private scheduleToolbarIdleDestroy(): void {
    this.clearToolbarIdleTimer()
    this.toolbarIdleTimer = setTimeout(() => {
      this.toolbarIdleTimer = null
      if (this.toolbarWindow && !this.toolbarWindow.isDestroyed() && !this.toolbarWindow.isVisible()) {
        this.toolbarWindow.close()
        this.toolbarWindow = null
      }
    }, 30_000)
  }

  private clearToolbarIdleTimer(): void {
    if (this.toolbarIdleTimer) {
      clearTimeout(this.toolbarIdleTimer)
      this.toolbarIdleTimer = null
    }
  }

  // A hidden action window is instant to reopen but pins its renderer.
  // Destroy it after 60s hidden; the next open recreates it lazily. Reuse
  // (openActionWindow) and 'show' cancel the timer.
  private scheduleActionIdleDestroy(win: BrowserWindow): void {
    this.cancelActionIdleDestroy(win)
    const timer = setTimeout(() => {
      this.actionIdleTimers.delete(win)
      if (win.isDestroyed() || win.isVisible()) return
      // Still streaming: destroying the renderer aborts the request and kills
      // the action mid-answer. Keep the window and check again later.
      if (hasActiveStream(win.webContents.id)) {
        this.scheduleActionIdleDestroy(win)
        return
      }
      win.destroy()
    }, ACTION_IDLE_DESTROY_MS)
    this.actionIdleTimers.set(win, timer)
  }

  private cancelActionIdleDestroy(win: BrowserWindow): void {
    const timer = this.actionIdleTimers.get(win)
    if (timer) {
      clearTimeout(timer)
      this.actionIdleTimers.delete(win)
    }
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
    this.toolbarReady = true
    this.clearToolbarShowFallbackTimer()
    if (Number.isFinite(width) && width > 0) {
      const display = this.pendingToolbarShow
        ? screen.getDisplayNearestPoint(this.pendingToolbarShow.anchor)
        : this.toolbarWindow && !this.toolbarWindow.isDestroyed()
          ? screen.getDisplayMatching(this.toolbarWindow.getBounds())
          : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      this.toolbarWidth = this.clampToolbarWidthForArea(Math.ceil(width), display.workArea.width)
    }
    if (this.pendingToolbarShow) {
      const pending = this.pendingToolbarShow
      this.pendingToolbarShow = null
      this.showToolbar(pending.anchor, pending.orientation, pending.payload)
      return
    }
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed() || !this.toolbarWindow.isVisible()) return

    const bounds = this.toolbarWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea
    const visibleX = bounds.x + TOOLBAR_SHADOW_PADDING
    const x = Math.round(Math.max(area.x, Math.min(visibleX, area.x + area.width - this.toolbarWidth)))
    const nextX = x - TOOLBAR_SHADOW_PADDING
    const nextWidth = this.getToolbarWindowWidth()
    const nextHeight = this.getToolbarWindowHeight()
    if (bounds.x === nextX && bounds.width === nextWidth && bounds.height === nextHeight) return
    this.toolbarWindow.setBounds({
      x: nextX,
      y: bounds.y,
      width: nextWidth,
      height: nextHeight
    })
  }

  processAction(payload: ActionPayload): void {
    const settings = this.getSettings()
    this.openActionWindow(payload, (win, siblingCount) => this.positionAndShowActionWindow(win, settings, siblingCount))
  }

  // Open a type-in window for an action (triggered by its global shortcut),
  // independent of the selection toolbar.
  openActionInput(action: ActionItem, forceNew = false): void {
    const settings = this.getSettings()
    const payload: ActionPayload = { action, selectedText: '', mode: 'input' }
    this.openActionWindow(
      payload,
      (win, siblingCount) => {
        if (win.isMinimized()) win.restore()
        this.positionActionWindowCenter(win, settings, siblingCount)
        this.presentActionWindow(win, !!settings.autoPin)
      },
      forceNew
    )
  }

  openNewActionWindow(action?: ActionItem): void {
    const settings = this.getSettings()
    const fallback =
      settings.actions.find((item) => item.enabled && item.type === 'prompt') ??
      settings.actions[0]
    const target = action ? resolveLiveActionItem(settings.actions, action) : fallback
    const resolved =
      target && settings.actions.some((item) => item.id === target.id)
        ? target
        : (fallback ?? target)
    if (!resolved) return
    this.openActionInput(resolved, true)
  }

  syncWindowSizeFromSettings(settings: AppSettings): void {
    this.lastActionSize = {
      width: settings.actionWindowWidth || ACTION_WIDTH,
      height: settings.actionWindowHeight || ACTION_HEIGHT
    }
  }

  // A visible window is already mounted: hand it the new payload and re-show it.
  // A hidden window (close turned into hide, see createActionWindow) is reused
  // the same way — its renderer is warm, so reopening is instant instead of a
  // full reload. Pinned windows are never overwritten so reference results stay
  // intact, and `forceNew` spawns an independent sibling window.
  private openActionWindow(
    payload: ActionPayload,
    show: (win: BrowserWindow, siblingCount: number) => void,
    forceNew = false
  ): void {
    const settings = this.getSettings()
    const nextPayload: ActionPayload = {
      ...payload,
      action: resolveLiveActionItem(settings.actions, payload.action),
      sessionId: payload.sessionId ?? randomUUID()
    }
    const candidates = Array.from(this.actionWindows)
      .filter((win) => !win.isDestroyed())
      .map((win) => ({
        win,
        visible: win.isVisible(),
        pinned: win.isAlwaysOnTop()
      }))
    const visibleSiblings = candidates.filter((c) => c.visible).length
    const existing = pickReusableSubWindow(candidates, forceNew)
    if (existing) {
      this.cancelActionIdleDestroy(existing)
      if (existing.isMinimized()) existing.restore()
      if (existing.webContents.isLoadingMainFrame()) {
        this.pendingInitialPayload.set(existing.webContents.id, nextPayload)
        return
      }
      existing.webContents.send(IPC.SelectionProcessAction, nextPayload)
      show(existing, 0)
      return
    }
    const win = this.createActionWindow()
    this.pendingInitialPayload.set(win.webContents.id, nextPayload)
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) show(win, visibleSiblings)
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
    ipcMain.on(IPC.SelectionGetInitialSelection, (event) => {
      event.returnValue = this.pendingInitialSelection
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
    this.toolbarReady = false

    const win = new BrowserWindow({
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
        sandbox: true,
        // Keep hidden toolbar responsive to SettingsChanged width updates so
        // reopening never waits for a deferred rAF resize.
        backgroundThrottling: false
      }
    })
    this.toolbarWindow = win

    if (isMac) {
      win.on('blur', () => this.hideToolbar())
    }
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed() || this.toolbarWindow !== win) return
      if (!this.toolbarReady && this.pendingToolbarShow) {
        this.clearToolbarShowFallbackTimer()
        this.toolbarShowFallbackTimer = setTimeout(() => {
          this.toolbarShowFallbackTimer = null
          if (win.isDestroyed() || this.toolbarWindow !== win) return
          this.toolbarReady = true
          if (this.pendingToolbarShow) {
            const pending = this.pendingToolbarShow
            this.pendingToolbarShow = null
            this.showToolbar(pending.anchor, pending.orientation, pending.payload)
          }
        }, 200)
      }
    })
    win.on('closed', () => {
      if (this.toolbarWindow === win) {
        this.toolbarWindow = null
        this.toolbarReady = false
        this.pendingToolbarShow = null
        this.pendingInitialSelection = null
        this.clearToolbarShowFallbackTimer()
        this.clearToolbarPointerDownState()
      }
    })
    win.webContents.on('render-process-gone', () => {
      if (this.toolbarWindow === win) {
        this.toolbarWindow = null
        this.toolbarReady = false
        this.pendingToolbarShow = null
        this.pendingInitialSelection = null
        this.clearToolbarIdleTimer()
        this.clearToolbarShowFallbackTimer()
        this.clearToolbarPointerDownState()
      }
      if (!win.isDestroyed()) win.destroy()
    })
    this.loadRenderer(win, 'selectionToolbar.html')
  }

  private createActionWindow(): BrowserWindow {
    const settings = this.getSettings()
    this.ensureLastActionSize(settings)
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
        sandbox: true,
        backgroundThrottling: false
      }
    })

    const wcId = win.webContents.id
    win.on('close', (event) => {
      // Quitting/disabled teardown uses destroy() and never lands here; a
      // user/OS close hides for fast reuse instead of destroying the renderer
      // (close → full reload was the reported open/close jank). Reset the
      // renderer first so active streams abort cleanly and reopening never
      // reveals the previous session's answer or draft text.
      if (this.quitting) return
      event.preventDefault()
      if (!win.isDestroyed()) {
        if (this.getSettings().rememberWindowSize) {
          const bounds = win.getBounds()
          this.lastActionSize = {
            width: Math.max(320, bounds.width - ACTION_SHADOW_PADDING * 2),
            height: Math.max(240, bounds.height - ACTION_SHADOW_PADDING * 2)
          }
          void this.updateSettings({
            actionWindowWidth: this.lastActionSize.width,
            actionWindowHeight: this.lastActionSize.height
          })
        }
        win.webContents.send(IPC.SelectionReset)
        if (win.isVisible()) win.hide()
      }
      this.scheduleActionIdleDestroy(win)
    })
    win.on('show', () => {
      this.cancelActionIdleDestroy(win)
    })
    win.on('closed', () => {
      this.actionWindows.delete(win)
      this.pendingInitialPayload.delete(wcId)
      this.cancelActionIdleDestroy(win)
    })
    win.webContents.on('render-process-gone', () => {
      this.actionWindows.delete(win)
      this.pendingInitialPayload.delete(wcId)
      this.cancelActionIdleDestroy(win)
      if (!win.isDestroyed()) win.destroy()
    })
    win.on('resized', () => {
      if (this.getSettings().rememberWindowSize && !win.isDestroyed()) {
        const bounds = win.getBounds()
        this.lastActionSize = {
          width: Math.max(320, bounds.width - ACTION_SHADOW_PADDING * 2),
          height: Math.max(240, bounds.height - ACTION_SHADOW_PADDING * 2)
        }
        // Persist to settings (debounced via updateSettings)
        void this.updateSettings({
          actionWindowWidth: this.lastActionSize.width,
          actionWindowHeight: this.lastActionSize.height
        })
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

  private handleSelection = (selection: TextSelectionData, fromShortcut = false): void => {
    if (!fromShortcut && this.toolbarPointerDownActive) return
    const text = selection.text?.trim()
    if (!text) return
    const settings = this.getSettings()
    if (!settings.enabled || !shouldProcessProgram(selection.programName, settings.filterMode, settings.filterList)) {
      return
    }
    if (!settings.actions.some((action) => action.enabled)) return

    this.createToolbarWindow()
    const { point, orientation } = this.resolveSelectionAnchor(selection)
    const payload: SelectedTextPayload = {
      text,
      programName: selection.programName,
      isFullscreen: selection.isFullscreen
    }
    this.pendingInitialSelection = payload
    if (!this.toolbarReady) {
      this.clearToolbarIdleTimer()
      this.pendingToolbarShow = { anchor: point, orientation, payload }
      this.startHideListeners()
      return
    }
    this.showToolbar(point, orientation, payload)
  }

  private resolveSelectionAnchor(selection: TextSelectionData): { point: Point; orientation: Orientation } {
    const positionLevel = this.hookCtor?.PositionLevel
    let point: Point = screen.getCursorScreenPoint()
    let orientation: Orientation = 'bottomMiddle'
    let isLogical = true

    if (positionLevel && selection.posLevel === positionLevel.MOUSE_SINGLE) {
      if (isValidSelectionPoint(selection.mousePosEnd)) {
        point = { x: selection.mousePosEnd.x, y: selection.mousePosEnd.y + 16 }
        isLogical = false
      }
    } else if (positionLevel && selection.posLevel === positionLevel.MOUSE_DUAL) {
      if (isValidSelectionPoint(selection.mousePosEnd)) {
        const yDistance = isValidSelectionPoint(selection.mousePosStart)
          ? selection.mousePosEnd.y - selection.mousePosStart.y
          : 0
        const xDistance = isValidSelectionPoint(selection.mousePosStart)
          ? selection.mousePosEnd.x - selection.mousePosStart.x
          : 0
        if (Math.abs(yDistance) > 14) {
          orientation = yDistance > 0 ? 'bottomLeft' : 'topRight'
          point = { x: selection.mousePosEnd.x, y: selection.mousePosEnd.y + (yDistance > 0 ? 16 : -16) }
        } else {
          orientation = xDistance >= 0 ? 'bottomLeft' : 'bottomRight'
          const baseY = isValidSelectionPoint(selection.mousePosStart)
            ? Math.max(selection.mousePosEnd.y, selection.mousePosStart.y)
            : selection.mousePosEnd.y
          point = { x: selection.mousePosEnd.x, y: baseY + 16 }
        }
        isLogical = false
      }
    } else if (
      positionLevel &&
      (selection.posLevel === positionLevel.SEL_FULL || selection.posLevel === positionLevel.SEL_DETAILED)
    ) {
      if (hasUsableSelectionRect(selection)) {
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
      } else if (
        isValidSelectionPoint(selection.mousePosEnd) &&
        !(selection.mousePosEnd.x === 0 && selection.mousePosEnd.y === 0)
      ) {
        orientation = 'bottomLeft'
        point = { x: selection.mousePosEnd.x, y: selection.mousePosEnd.y + 16 }
        isLogical = false
      }
    }

    if (!isLogical && isWin) point = screen.screenToDipPoint(point)
    return { point: { x: Math.round(point.x), y: Math.round(point.y) }, orientation }
  }

  private showToolbar(anchor: Point, orientation: Orientation, payload: SelectedTextPayload): void {
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    this.clearToolbarIdleTimer()
    this.clearToolbarShowFallbackTimer()
    this.pendingToolbarShow = null
    this.pendingInitialSelection = payload
    const position = this.calculateToolbarPosition(anchor, orientation)
    const toolbarBounds = {
      x: position.x - TOOLBAR_SHADOW_PADDING,
      y: position.y - TOOLBAR_SHADOW_PADDING,
      width: this.getToolbarWindowWidth(),
      height: this.getToolbarWindowHeight()
    }
    const wasVisible = this.toolbarWindow.isVisible()
    this.toolbarWindow.setBounds(toolbarBounds)
    this.toolbarWindow.setAlwaysOnTop(true, 'screen-saver')
    this.toolbarWindow.webContents.send(IPC.SelectionSelected, payload)
    this.toolbarWindow.webContents.send(IPC.SelectionVisibility, true)
    if (!wasVisible) {
      if (isWin) {
        // Chromium hides the render-widget child HWND when the BrowserWindow is
        // hidden and never restores it on re-show, so a warm toolbar paints but
        // swallows every click (WindowFromPoint resolves to the top-level HWND,
        // and the buttons never fire). Only a real geometry change makes Chromium
        // re-show the child, so nudge the height by 1px while still hidden — the
        // 16px content margin keeps the pill pixel-identical.
        this.toolbarWindow.setBounds({ ...toolbarBounds, height: toolbarBounds.height + 1 })
        this.toolbarWindow.setBounds(toolbarBounds)
      }
      if (isMac || isWin) {
        this.toolbarWindow.showInactive()
      } else {
        this.toolbarWindow.show()
      }
    }
    if (isWin) {
      // Re-assert Z-order, bounds, and mouse hit-testing after showInactive() on warm reused HWNDs.
      this.toolbarWindow.setIgnoreMouseEvents(false)
      this.toolbarWindow.setBounds(toolbarBounds)
      this.toolbarWindow.setAlwaysOnTop(true, 'screen-saver')
      this.toolbarWindow.moveTop()
    } else if (!wasVisible) {
      this.toolbarWindow.moveTop()
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

  /** Ensure lastActionSize is initialized from persisted settings */
  private ensureLastActionSize(settings: AppSettings): void {
    if (this.lastActionSize.width === 0 || this.lastActionSize.height === 0) {
      this.lastActionSize = {
        width: settings.actionWindowWidth || ACTION_WIDTH,
        height: settings.actionWindowHeight || ACTION_HEIGHT
      }
    }
  }

  private positionAndShowActionWindow(win: BrowserWindow, settings: AppSettings, siblingCount = 0): void {
    this.ensureLastActionSize(settings)
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

    if (siblingCount > 0) {
      const cascaded = cascadeWindowOrigin(x, y, width, height, area, siblingCount)
      x = cascaded.x
      y = cascaded.y
    }

    if (win.isMinimized()) win.restore()
    win.setBounds({
      x: x - ACTION_SHADOW_PADDING,
      y: y - ACTION_SHADOW_PADDING,
      width: this.getActionWindowWidth(width),
      height: this.getActionWindowHeight(height)
    })
    this.presentActionWindow(win, !!settings.autoPin)
  }

  private presentActionWindow(win: BrowserWindow, alwaysOnTop: boolean, focusWindow = true): void {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (isWin) {
      if (focusWindow) {
        // Promote transiently to screen-saver topmost so a warm hidden HWND rises above
        // the active foreground app even when FlashAgent lacks Windows foreground lock.
        win.setAlwaysOnTop(true, 'screen-saver')
        win.show()
        win.moveTop()
        win.focus()
        win.setAlwaysOnTop(alwaysOnTop)
      } else {
        win.setAlwaysOnTop(alwaysOnTop)
        win.showInactive()
      }
      return
    }
    win.setAlwaysOnTop(alwaysOnTop)
    if (isMac && alwaysOnTop) win.showInactive()
    else {
      win.show()
      if (focusWindow) win.focus()
    }
  }

  private positionActionWindowCenter(win: BrowserWindow, settings: AppSettings, siblingCount = 0): void {
    this.ensureLastActionSize(settings)
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = settings.rememberWindowSize ? this.lastActionSize.width : settings.actionWindowWidth
    const height = settings.rememberWindowSize ? this.lastActionSize.height : settings.actionWindowHeight
    const baseX = Math.round(area.x + (area.width - width) / 2)
    const baseY = Math.round(area.y + (area.height - height) / 2)
    const { x, y } =
      siblingCount > 0
        ? cascadeWindowOrigin(baseX, baseY, width, height, area, siblingCount)
        : { x: baseX, y: baseY }
    win.setBounds({
      x: x - ACTION_SHADOW_PADDING,
      y: y - ACTION_SHADOW_PADDING,
      width: this.getActionWindowWidth(width),
      height: this.getActionWindowHeight(height)
    })
  }

  private startHideListeners(): void {
    if (!this.hook || this.hideListenerActive) return
    this.hook.on('mouse-down', this.handleMouseDownHide)
    this.hook.on('mouse-up', this.handleMouseUpClearPointer)
    this.hook.on('mouse-wheel', this.handleHide)
    this.hook.on('key-down', this.handleKeyDownHide)
    this.hideListenerActive = true
  }

  private stopHideListeners(): void {
    if (!this.hook || !this.hideListenerActive) return
    this.hook.off('mouse-down', this.handleMouseDownHide)
    this.hook.off('mouse-up', this.handleMouseUpClearPointer)
    this.hook.off('mouse-wheel', this.handleHide)
    this.hook.off('key-down', this.handleKeyDownHide)
    this.hideListenerActive = false
  }

  private handleHide = (): void => this.hideToolbar()

  private handleMouseUpClearPointer = (): void => {
    if (!this.toolbarPointerDownActive) return
    if (this.toolbarPointerDownTimer) clearTimeout(this.toolbarPointerDownTimer)
    // Delay slightly so a text-selection NonBlockingCall queued on the same
    // WM_LBUTTONUP tick (from an unfocused toolbar drag) is still suppressed.
    this.toolbarPointerDownTimer = setTimeout(() => {
      this.toolbarPointerDownTimer = null
      this.toolbarPointerDownActive = false
    }, 80)
  }

  private handleMouseDownHide = (event: MouseEventData): void => {
    if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
    if (!this.toolbarWindow.isVisible()) {
      if (this.pendingToolbarShow) this.hideToolbar()
      return
    }
    const point = isWin ? screen.screenToDipPoint({ x: event.x, y: event.y }) : { x: event.x, y: event.y }
    const bounds = this.toolbarWindow.getBounds()
    const inside = isPointInsideToolbarHitbox(
      point,
      bounds,
      this.toolbarWidth,
      TOOLBAR_SHADOW_PADDING,
      TOOLBAR_HEIGHT
    )
    if (inside) {
      this.markToolbarPointerDown()
      return
    }
    this.hideToolbar()
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
