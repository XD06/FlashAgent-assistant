import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppSettings, OcrEngineStatusPayload } from '@shared/types'
import { showResultToast } from '../toast'
import { isWin } from '../platform'
import { isSystemOcrAvailable, listSystemOcrLanguages, recognizeWithSystem } from './winrt'
import {
  EngineNotInstalledError,
  destroyPaddleOcr,
  paddleEngineRoot,
  recognizeWithPaddle
} from './paddle'
import { deleteEnginePack, downloadEnginePack, getEngineState } from './enginePack'

// OCR entry point for the screenshot "copy text" action. Two engines:
//  - 'system': Windows.Media.Ocr via the on-demand compiled helper — zero
//    download, fastest, gist-level accuracy (see docs/ocr-winrt-test-result.md).
//  - 'paddle': offline PP-OCRv6 via the optional engine pack — high accuracy,
//    downloads on demand into userData, kept on non-Windows platforms.

export interface OcrResult {
  text: string
  /** Engine confidence in [0,1]; null when the engine does not report one. */
  confidence: number | null
  elapsedMs: number
  engine: 'system' | 'paddle'
}

function resolveEngine(settings: AppSettings): 'system' | 'paddle' {
  if (settings.ocrEngine === 'paddle') return 'paddle'
  // The system engine is Windows-only; other platforms keep the paddle engine.
  return isWin ? 'system' : 'paddle'
}

/** Recognize a PNG data URL and return the flattened text. */
export async function recognizeDataUrl(dataUrl: string, settings: AppSettings): Promise<OcrResult> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const png = Buffer.from(base64, 'base64')

  if (resolveEngine(settings) === 'system') {
    const { text, elapsedMs } = await recognizeWithSystem(png, settings.language)
    return { text, confidence: null, elapsedMs, engine: 'system' }
  }
  const { text, confidence, elapsedMs } = await recognizeWithPaddle(png)
  return { text, confidence, elapsedMs, engine: 'paddle' }
}

export async function destroyOcr(): Promise<void> {
  // The system helper is a short-lived process — only the paddle engine holds
  // resident state worth releasing.
  await destroyPaddleOcr()
}

/** Recognize the image and copy the text to the clipboard, confirming via a
 * system notification (the overlay is gone by the time this runs). */
export async function recognizeAndCopy(dataUrl: string, settings: AppSettings): Promise<void> {
  const isZh = settings.language === 'zh-CN'
  try {
    const result = await recognizeDataUrl(dataUrl, settings)
    if (!result.text) {
      showResultToast(isZh ? '文字识别' : 'OCR', isZh ? '未识别到文字' : 'No text recognized', 'error')
      return
    }
    clipboard.writeText(result.text)
    const quality =
      result.confidence != null
        ? `${(result.confidence * 100).toFixed(0)}%`
        : isZh
          ? '系统引擎'
          : 'system engine'
    showResultToast(
      isZh ? '文字识别' : 'OCR',
      isZh
        ? `已复制 ${result.text.length} 个字符 · ${quality} · ${result.elapsedMs}ms`
        : `Copied ${result.text.length} characters · ${quality} · ${result.elapsedMs}ms`,
      'ok'
    )
  } catch (error) {
    if (error instanceof EngineNotInstalledError) {
      showResultToast(
        isZh ? '高精度OCR未安装' : 'OCR engine missing',
        isZh
          ? '请在 设置 → 功能模型 中下载高精度OCR引擎'
          : 'Download the high-accuracy OCR engine in Settings → Feature models first',
        'error'
      )
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      resolveEngine(settings) === 'paddle'
        ? isZh
          ? `${message}（首次使用需下载模型，请检查网络或代理）`
          : `${message} (first use downloads models — check network or proxy)`
        : message
    showResultToast(isZh ? '文字识别失败' : 'OCR failed', hint, 'error')
  }
}

// --- Engine pack management IPC (settings UI) ---

let systemLanguagesCache: string[] | null = null

async function getSystemLanguages(): Promise<string[]> {
  if (!isSystemOcrAvailable()) return []
  if (systemLanguagesCache) return systemLanguagesCache
  try {
    systemLanguagesCache = await listSystemOcrLanguages()
  } catch {
    systemLanguagesCache = []
  }
  return systemLanguagesCache
}

let downloadAbort: AbortController | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function engineStatusPayload(downloading: boolean): OcrEngineStatusPayload {
  const state = getEngineState(paddleEngineRoot())
  return {
    systemAvailable: isSystemOcrAvailable(),
    systemLanguages: [],
    paddle: { installed: state.installed, bytes: state.bytes },
    downloading,
    progress: null
  }
}

export function registerOcrIpc(): void {
  ipcMain.handle(IPC.OcrEngineStatus, async (): Promise<OcrEngineStatusPayload> => {
    const payload = engineStatusPayload(!!downloadAbort)
    payload.systemLanguages = await getSystemLanguages()
    return payload
  })

  ipcMain.handle(IPC.OcrEngineDownload, async () => {
    if (downloadAbort) return false
    downloadAbort = new AbortController()
    broadcast(IPC.OcrEngineChanged, engineStatusPayload(true))
    try {
      await downloadEnginePack(
        paddleEngineRoot(),
        (progress) => broadcast(IPC.OcrEngineProgress, progress),
        downloadAbort.signal
      )
      return true
    } finally {
      downloadAbort = null
      broadcast(IPC.OcrEngineChanged, engineStatusPayload(false))
    }
  })

  ipcMain.handle(IPC.OcrEngineDownloadCancel, () => {
    downloadAbort?.abort()
    return true
  })

  ipcMain.handle(IPC.OcrEngineDelete, async () => {
    if (downloadAbort) downloadAbort.abort()
    await destroyPaddleOcr()
    deleteEnginePack(paddleEngineRoot())
    broadcast(IPC.OcrEngineChanged, engineStatusPayload(false))
    return true
  })
}
