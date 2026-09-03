import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { engineModulePath, getEngineState } from './enginePack'

// Offline high-accuracy OCR (PP-OCRv6 via ppu-paddle-ocr, onnxruntime under
// the hood). The engine is no longer bundled with the app: the package tree
// lives in <userData>/ocr-engine (downloaded on demand, see enginePack.ts)
// and loads through a runtime file-URL import — a variable specifier +
// @vite-ignore keeps the bundler from rewriting it into require().
//
// The engine is heavy (~200MB RSS once loaded) but used in bursts, so the
// singleton lazy-loads on first use and destroys itself after idle time.

const IDLE_DESTROY_MS = 90_000

/** Thrown when the user picks the high-accuracy engine before downloading it. */
export class EngineNotInstalledError extends Error {
  constructor() {
    super('high-accuracy OCR engine is not installed')
    this.name = 'EngineNotInstalledError'
  }
}

export function paddleEngineRoot(): string {
  return join(app.getPath('userData'), 'ocr-engine')
}

export function isPaddleEngineInstalled(): boolean {
  return getEngineState(paddleEngineRoot()).installed
}

// Structural types for the downloaded ESM module (the package itself is no
// longer a dependency, so its .d.ts cannot be imported).
interface PaddleOcrResult {
  text?: string
  confidence?: number
}

interface PaddleOcrEngine {
  initialize(): Promise<void>
  recognize(input: ArrayBuffer, options: { flatten: boolean }): Promise<PaddleOcrResult>
  destroy(): Promise<void>
}

interface PaddleOcrModule {
  PaddleOcrService: new () => PaddleOcrEngine
}

let modulePromise: Promise<PaddleOcrModule> | null = null

async function loadModule(): Promise<PaddleOcrModule> {
  modulePromise ??= (async () => {
    if (!isPaddleEngineInstalled()) throw new EngineNotInstalledError()
    const entry = join(engineModulePath(paddleEngineRoot(), 'ppu-paddle-ocr'), 'index.js')
    const specifier = pathToFileURL(entry).href
    return (await import(/* @vite-ignore */ specifier)) as PaddleOcrModule
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
  modulePromise = null
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
