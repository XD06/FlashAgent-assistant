// Offline high-accuracy OCR (PP-OCRv6 via ppu-paddle-ocr, onnxruntime under
// the hood). The engine is heavy (~200MB RSS once loaded) but used in bursts,
// so the singleton lazy-loads on first use and destroys itself after idle
// time. ppu-paddle-ocr is ESM-only while the main bundle is CJS, so the module
// is loaded through a runtime dynamic import (variable specifier +
// @vite-ignore keeps the bundler from rewriting it into require()).

const IDLE_DESTROY_MS = 90_000

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
    void destroyPaddleOcr()
  }, IDLE_DESTROY_MS)
}

export async function destroyPaddleOcr(): Promise<void> {
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

export async function recognizeWithPaddle(
  png: Buffer
): Promise<{ text: string; confidence: number | null; elapsedMs: number }> {
  const started = Date.now()
  const arrayBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
  const ocr = await getOcr()
  const result = await ocr.recognize(arrayBuffer, { flatten: true })
  scheduleIdleDestroy()
  return {
    text: (result.text ?? '').trim(),
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    elapsedMs: Date.now() - started
  }
}
