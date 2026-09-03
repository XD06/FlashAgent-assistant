import { clipboard, Notification } from 'electron'
import { PaddleOcrService } from 'ppu-paddle-ocr'
import type { AppSettings } from '@shared/types'

// Offline OCR (PP-OCRv6 via ppu-paddle-ocr, pure TypeScript + onnxruntime).
// The engine is heavy (~200MB RSS once loaded) but used in bursts, so the
// singleton lazy-loads on first use and destroys itself after idle time.

const IDLE_DESTROY_MS = 3 * 60_000

let service: PaddleOcrService | null = null
let initPromise: Promise<PaddleOcrService> | null = null
let idleTimer: NodeJS.Timeout | null = null

async function createService(): Promise<PaddleOcrService> {
  const instance = new PaddleOcrService()
  // v6-tiny: 6.4MB total, ~200ms per screenshot, 0.98 confidence on UI text —
  // the right accuracy/size trade-off for quick copy-text (see
  // docs/OCR.md). Models are cached under ~/.cache/ppu-paddle-ocr after the
  // first download.
  await instance.initialize()
  return instance
}

async function getOcr(): Promise<PaddleOcrService> {
  if (service) return service
  initPromise ??= createService()
    .then((instance) => {
      service = instance
      return instance
    })
    .catch((error) => {
      initPromise = null
      throw error
    })
  return initPromise
}

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    void destroyOcr()
  }, IDLE_DESTROY_MS)
}

export async function destroyOcr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const instance = service
  service = null
  initPromise = null
  if (instance) {
    try {
      await instance.destroy()
    } catch {
      // Engine already gone — nothing to clean up.
    }
  }
}

export interface OcrResult {
  text: string
  confidence: number
  elapsedMs: number
}

/** Recognize a PNG data URL and return the flattened text. */
export async function recognizeDataUrl(dataUrl: string): Promise<OcrResult> {
  const started = Date.now()
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const png = Buffer.from(base64, 'base64')
  const arrayBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)

  const ocr = await getOcr()
  const result = await ocr.recognize(arrayBuffer, { flatten: true })
  scheduleIdleDestroy()

  return {
    text: (result.text ?? '').trim(),
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    elapsedMs: Date.now() - started
  }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body, silent: true }).show()
  } catch {
    // Notifications are best-effort; the clipboard already has the text.
  }
}

/** Recognize the image and copy the text to the clipboard, confirming via a
 * system notification (the overlay is gone by the time this runs). */
export async function recognizeAndCopy(dataUrl: string, settings: AppSettings): Promise<void> {
  const isZh = settings.language === 'zh-CN'
  try {
    const result = await recognizeDataUrl(dataUrl)
    if (!result.text) {
      notify(isZh ? '文字识别' : 'OCR', isZh ? '未识别到文字' : 'No text recognized')
      return
    }
    clipboard.writeText(result.text)
    notify(
      isZh ? '文字识别' : 'OCR',
      isZh
        ? `已复制 ${result.text.length} 个字符（置信度 ${(result.confidence * 100).toFixed(0)}%，${result.elapsedMs}ms）`
        : `Copied ${result.text.length} characters (confidence ${(result.confidence * 100).toFixed(0)}%, ${result.elapsedMs}ms)`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notify(
      isZh ? '文字识别失败' : 'OCR failed',
      isZh
        ? `${message}（首次使用需下载模型，请检查网络或代理）`
        : `${message} (first use downloads models — check network or proxy)`
    )
  }
}
