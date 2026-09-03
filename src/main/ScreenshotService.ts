import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import { isMac } from './platform'
import { captureDisplay } from './capture'
import { recognizeAndCopy } from './ocr'
import { applyPngDpi } from './pngDpi'

export interface OverlayInitPayload {
  imageDataUrl: string
  displayId: number
  // Display size in logical CSS pixels (rotation-aware)
  width: number
  height: number
  // Actual pixel dimensions of the captured image (may differ from
  // display.size * scaleFactor on Windows / rotated displays).
  imageWidth: number
  imageHeight: number
}

export type OverlayAction = 'explain' | 'save' | 'copy' | 'pin' | 'ocr'

export interface OverlayConfirmPayload {
  displayId: number
  // Selection rect in CSS pixels of the overlay window viewport
  x: number
  y: number
  width: number
  height: number
  // Overlay viewport size (window.innerWidth/innerHeight) so main can
  // compute the correct crop ratio against the actual image pixels.
  viewportWidth: number
  viewportHeight: number
  action: OverlayAction
  // Optional pre-rasterized image (already cropped + annotated by the
  // renderer). When present we use this directly and skip cropping.
  imageDataUrl?: string
}

interface DisplayCapture {
  display: Electron.Display
  image: Electron.NativeImage
  dataUrl: string
}

interface PinState {
  dataUrl: string
  baseWidth: number
  baseHeight: number
  aspectRatio: number
  scale: number
  minScale: number
  maxScale: number
  /** DPI of the display the pin was created on — tags saved PNGs so viewers
   * render them at the original logical size instead of upscaling. */
  dpi: number
}

export class ScreenshotService {
  private overlayWindow: BrowserWindow | null = null
  private pinWindows = new Map<BrowserWindow, PinState>()
  private currentCapture: DisplayCapture | null = null
  private capturing = false

  constructor(
    private getSettings: () => AppSettings,
    private preloadPath: string,
    private rendererDir: string,
    private windowIcon: Electron.NativeImage,
    /** Route AI vision into the shared action window (avoids a third React process). */
    private onExplainImage: (imageDataUrl: string) => void = () => undefined
  ) {}

  registerIpc(): void {
    ipcMain.handle(IPC.ScreenshotStart, () => this.startCapture())
    ipcMain.handle(IPC.ScreenshotOverlayReady, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && win === this.overlayWindow && this.currentCapture) {
        const imageSize = this.currentCapture.image.getSize()
        const payload: OverlayInitPayload = {
          imageDataUrl: this.currentCapture.dataUrl,
          displayId: this.currentCapture.display.id,
          width: this.currentCapture.display.size.width,
          height: this.currentCapture.display.size.height,
          imageWidth: imageSize.width,
          imageHeight: imageSize.height
        }
        event.sender.send(IPC.ScreenshotOverlayInit, payload)
      }
    })
    ipcMain.handle(IPC.ScreenshotOverlayConfirm, (_event, payload: OverlayConfirmPayload) =>
      this.handleOverlayConfirm(payload)
    )
    // Cancel must also drop the capture: a full-screen NativeImage plus its
    // data URL would otherwise sit in memory until the next screenshot.
    ipcMain.handle(IPC.ScreenshotOverlayCancel, () => {
      this.currentCapture = null
      this.closeOverlay()
    })
    ipcMain.handle(IPC.ScreenshotSave, (_event, dataUrl: string) => this.saveImage(dataUrl))
    ipcMain.handle(IPC.ScreenshotCopy, (_event, dataUrl: string) => this.copyImage(dataUrl))
    ipcMain.handle(IPC.ScreenshotPin, (_event, dataUrl: string) => this.pinImage(dataUrl))
    ipcMain.handle(IPC.ScreenshotPinZoom, (event, deltaY: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) this.zoomPin(win, deltaY)
    })
    ipcMain.handle(IPC.ScreenshotPinMove, (event, dx: number, dy: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      const bounds = win.getBounds()
      win.setPosition(Math.round(bounds.x + dx), Math.round(bounds.y + dy), false)
    })
    ipcMain.handle(IPC.ScreenshotPinMenu, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) this.showPinMenu(win)
    })
  }

  dispose(): void {
    this.currentCapture = null
    this.closeOverlay()
    for (const win of this.pinWindows.keys()) {
      if (!win.isDestroyed()) win.close()
    }
    this.pinWindows.clear()
  }

  async startCapture(): Promise<void> {
    if (this.capturing) return
    this.capturing = true
    try {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      // Native-resolution frame (GDI helper / screencapture); the
      // desktopCapturer thumbnail path can return an upscaled lower-res
      // frame, which read as a blurry overlay during region selection.
      const image = await captureDisplay(display)

      this.currentCapture = {
        display,
        image,
        dataUrl: image.toDataURL()
      }
      this.openOverlay(display)
    } catch (error) {
      console.error('Screenshot capture failed', error)
      this.currentCapture = null
    } finally {
      this.capturing = false
    }
  }

  private openOverlay(display: Electron.Display): void {
    this.closeOverlay()
    const { x, y, width, height } = display.bounds
    this.overlayWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      // Windows: transparent windows rasterize at 1x and get upscaled on
      // scaled displays (~1.5x blur on the frozen frame). The overlay shows a
      // frozen capture anyway, so it is opaque on Windows. macOS transparent
      // panels render correctly and keep transparency.
      transparent: isMac,
      backgroundColor: isMac ? '#00000000' : '#000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      ...(isMac ? { type: 'panel' as const, hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The overlay must keep rastering at full resolution while visible:
        // throttling low-res tiles are what make the frozen frame look blurry.
        backgroundThrottling: false
      }
    })
    this.overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    const overlay = this.overlayWindow
    overlay.on('closed', () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null
    })

    this.loadRenderer(overlay, 'screenshotOverlay.html')
    overlay.once('ready-to-show', () => {
      overlay.show()
      overlay.focus()
    })
  }

  private closeOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close()
    }
    this.overlayWindow = null
  }

  private async handleOverlayConfirm(payload: OverlayConfirmPayload): Promise<void> {
    const capture = this.currentCapture
    this.closeOverlay()
    if (!capture) return

    let dataUrl: string
    let size: { width: number; height: number }

    if (payload.imageDataUrl) {
      // Renderer has already rasterized the crop (with annotations).
      const image = nativeImage.createFromDataURL(payload.imageDataUrl)
      this.currentCapture = null
      if (image.isEmpty()) return
      dataUrl = payload.imageDataUrl
      size = image.getSize()
    } else {
      // Map selection from overlay-viewport CSS pixels to the actual captured
      // image pixels using the real viewport/image ratio. This is robust to
      // DPI scaling, display rotation, and any minor window-size mismatch
      // (e.g. Windows truncating the taskbar region).
      const imageSize = capture.image.getSize()
      const vpW = Math.max(1, payload.viewportWidth || capture.display.size.width)
      const vpH = Math.max(1, payload.viewportHeight || capture.display.size.height)
      const scaleX = imageSize.width / vpW
      const scaleY = imageSize.height / vpH
      const cropX = Math.max(0, Math.min(imageSize.width - 1, Math.round(payload.x * scaleX)))
      const cropY = Math.max(0, Math.min(imageSize.height - 1, Math.round(payload.y * scaleY)))
      const cropW = Math.max(1, Math.min(imageSize.width - cropX, Math.round(payload.width * scaleX)))
      const cropH = Math.max(1, Math.min(imageSize.height - cropY, Math.round(payload.height * scaleY)))
      const cropped = capture.image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
      this.currentCapture = null
      if (cropped.isEmpty()) return
      dataUrl = cropped.toDataURL()
      size = cropped.getSize()
    }

    switch (payload.action) {
      case 'save':
        await this.saveImage(dataUrl, capture.display.scaleFactor * 96)
        return
      case 'copy':
        this.copyImage(dataUrl)
        return
      case 'pin':
        this.pinImage(dataUrl)
        return
      case 'ocr':
        // Offline OCR runs in-process; the engine lazy-loads on first use and
        // recycles after idle (see src/main/ocr).
        void recognizeAndCopy(dataUrl, this.getSettings())
        return
      case 'explain':
      default:
        this.onExplainImage(dataUrl)
    }
  }

  private async saveImage(dataUrl: string, dpi = 96): Promise<boolean> {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) {
      console.warn('[screenshot] saveImage: empty image')
      return false
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    const downloads = (() => {
      try {
        return app.getPath('downloads')
      } catch {
        return app.getPath('home')
      }
    })()
    const defaultPath = join(downloads, `screenshot-${stamp}.png`)
    const options = {
      title: 'Save Screenshot',
      defaultPath,
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    }

    // Bring our app to the front before showing the dialog. When save is
    // triggered from the overlay (which is a macOS panel), the overlay closes
    // and the dialog can otherwise open behind whatever app was previously
    // focused, looking like "nothing happened".
    try {
      app.focus({ steal: true })
    } catch {
      // ignore — older Electron may not support this signature
    }

    try {
      const result = await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      await writeFile(result.filePath, image.toPNG())
      return true
    } catch (error) {
      console.error('[screenshot] saveImage failed:', error)
      return false
    }
  }

  private copyImage(dataUrl: string): boolean {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  }

  private pinImage(dataUrl: string): void {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const sf = display.scaleFactor || 1
    const bitmap = image.getSize()
    // bitmap is in physical pixels; window units are logical
    const baseW = Math.max(40, Math.round(bitmap.width / sf))
    const baseH = Math.max(40, Math.round(bitmap.height / sf))
    const aspect = baseW / baseH

    // Initial scale: 1 if it fits, otherwise shrink to fit work area
    const fitW = display.workArea.width * 0.95
    const fitH = display.workArea.height * 0.95
    const initScale = Math.min(1, fitW / baseW, fitH / baseH)
    const winW = Math.round(baseW * initScale)
    const winH = Math.round(baseH * initScale)

    const pin = new BrowserWindow({
      width: winW,
      height: winH,
      x: Math.max(display.workArea.x, cursor.x - Math.round(winW / 2)),
      y: Math.max(display.workArea.y, cursor.y - Math.round(winH / 2)),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      ...(isMac ? { type: 'panel' as const, hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: this.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true
      }
    })
    pin.setAlwaysOnTop(true, isMac ? 'floating' : 'pop-up-menu')

    const minScale = Math.max(0.1, 40 / Math.min(baseW, baseH))
    const maxScale = Math.min(8, Math.max(display.workArea.width, display.workArea.height) / Math.max(baseW, baseH))
    this.pinWindows.set(pin, {
      dataUrl,
      baseWidth: baseW,
      baseHeight: baseH,
      aspectRatio: aspect,
      scale: initScale,
      minScale,
      maxScale,
      dpi: sf * 96
    })
    pin.on('closed', () => this.pinWindows.delete(pin))
    this.loadRenderer(pin, 'screenshotPin.html')
    pin.webContents.once('did-finish-load', () => {
      // Re-assert alwaysOnTop after content loads — on Windows the initial
      // call can be lost for transparent windows, causing the pin to fall
      // behind all other windows.
      if (!isMac) pin.setAlwaysOnTop(true, 'pop-up-menu')
      pin.webContents.send(IPC.ScreenshotPinInit, { imageDataUrl: dataUrl, width: baseW, height: baseH })
    })
  }

  private zoomPin(win: BrowserWindow, deltaY: number): void {
    const state = this.pinWindows.get(win)
    if (!state || win.isDestroyed()) return
    // wheel up (negative deltaY) = zoom in
    const factor = Math.exp(-deltaY * 0.0015)
    const next = Math.max(state.minScale, Math.min(state.maxScale, state.scale * factor))
    if (Math.abs(next - state.scale) < 1e-3) return
    state.scale = next
    const bounds = win.getBounds()
    const newW = Math.max(40, Math.round(state.baseWidth * next))
    const newH = Math.max(40, Math.round(state.baseHeight * next))
    // Keep window centered around its current center
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    win.setBounds({
      x: Math.round(cx - newW / 2),
      y: Math.round(cy - newH / 2),
      width: newW,
      height: newH
    })
  }

  private showPinMenu(win: BrowserWindow): void {
    const state = this.pinWindows.get(win)
    if (!state) return
    const language = this.getSettings().language
    const isZh = language === 'zh-CN'
    const labels = isZh
      ? { explain: 'AI 识图', copy: '复制图片', save: '保存图片', opacity: '透明度', reset: '重置大小', close: '关闭' }
      : { explain: 'AI Explain', copy: 'Copy image', save: 'Save image', opacity: 'Opacity', reset: 'Reset size', close: 'Close' }

    const opacityLevels = [1.0, 0.8, 0.6, 0.4, 0.2]
    const currentOpacity = win.getOpacity()

    const menu = Menu.buildFromTemplate([
      {
        label: labels.explain,
        click: () => this.onExplainImage(state.dataUrl)
      },
      {
        label: labels.copy,
        click: () => this.copyImage(state.dataUrl)
      },
      {
        label: labels.save,
        click: () => void this.saveImage(state.dataUrl, state.dpi)
      },
      { type: 'separator' },
      {
        label: labels.opacity,
        submenu: opacityLevels.map((value) => ({
          label: `${Math.round(value * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(currentOpacity - value) < 0.05,
          click: () => win.setOpacity(value)
        }))
      },
      {
        label: labels.reset,
        click: () => this.resetPinScale(win)
      },
      { type: 'separator' },
      {
        label: labels.close,
        click: () => {
          if (!win.isDestroyed()) win.close()
        }
      }
    ])
    menu.popup({ window: win })
  }

  private resetPinScale(win: BrowserWindow): void {
    const state = this.pinWindows.get(win)
    if (!state || win.isDestroyed()) return
    state.scale = 1
    const bounds = win.getBounds()
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    win.setBounds({
      x: Math.round(cx - state.baseWidth / 2),
      y: Math.round(cy - state.baseHeight / 2),
      width: state.baseWidth,
      height: state.baseHeight
    })
    win.setOpacity(1)
  }

  private loadRenderer(win: BrowserWindow, page: string): void {
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`)
    } else {
      void win.loadFile(join(this.rendererDir, page))
    }
  }
}
