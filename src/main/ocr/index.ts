import { clipboard } from 'electron'
import type { AppSettings } from '@shared/types'
import { showResultToast } from '../toast'

// Offline OCR (PP-OCRv6 via ppu-paddle-ocr, pure TypeScript + onnxruntime).
// The engine is heavy (~200MB RSS once loaded) but used in bursts, so the
// singleton lazy-loads on first use and destroys itself after idle time.
// ppu-paddle-ocr is ESM-only while the main bundle is CJS, so the module is
// loaded through a runtime dynamic import (variable specifier + @vite-ignore
// keeps the bundler from rewriting it into require()).

const IDLE_DESTROY_MS = 3 * 60_000

type PaddleOcrModule = typeof import('ppu-paddle-ocr')
type PaddleOcrEngine = import('ppu-paddle-ocr').PaddleOcrService

let modulePromise: Promise<PaddleOcrModule> | null = null

async function loadModule(): Promise<PaddleOcrModule> {
  modulePromise ??= (async () => {
    const moduleName = 'ppu-paddle-ocr'
    return (await import(/* @vite-ignore */ moduleName)) as PaddleOcrModule
  })()
  return modulePromise
}

let service: PaddleOcrEngine | null = null
let initPromise: Promise<PaddleOcrEngine> | null = null
let idleTimer: NodeJS.Timeout | null = null

async function createService(): Promise<PaddleOcrEngine> {
  const { PaddleOcrService } = await loadModule()
  // v6-tiny: 6.4MB total, ~200ms per screenshot, 0.95+ confidence on UI text —
  // the right accuracy/size trade-off for quick copy-text (see
  // docs/OCR.md). Models are cached under ~/.cache/ppu-paddle-ocr after the
  // first download.
  const instance = new PaddleOcrService()
  await instance.initialize()
  return instance
}

async function getOcr(): Promise<PaddleOcrEngine> {
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

/** Recognize the image and copy the text to the clipboard, confirming via a
 * system notification (the overlay is gone by the time this runs). */
export async function recognizeAndCopy(dataUrl: string, settings: AppSettings): Promise<void> {
  const isZh = settings.language === 'zh-CN'
  try {
    const result = await recognizeDataUrl(dataUrl)
    if (!result.text) {
      showResultToast(isZh ? '文字识别' : 'OCR', isZh ? '未识别到文字' : 'No text recognized', 'error')
      return
    }
    clipboard.writeText(result.text)
    showResultToast(
      isZh ? '文字识别' : 'OCR',
      isZh
        ? `已复制 ${result.text.length} 个字符 · 置信度 ${(result.confidence * 100).toFixed(0)}% · ${result.elapsedMs}ms`
        : `Copied ${result.text.length} characters · confidence ${(result.confidence * 100).toFixed(0)}% · ${result.elapsedMs}ms`,
      'ok'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showResultToast(
      isZh ? '文字识别失败' : 'OCR failed',
      isZh
        ? `${message}（首次使用需下载模型，请检查网络或代理）`
        : `${message} (first use downloads models — check network or proxy)`,
      'error'
    )
  }
}
