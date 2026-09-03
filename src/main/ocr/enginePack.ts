import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetch } from 'undici'

// Optional high-accuracy OCR engine pack (ppu-paddle-ocr + its runtime tree).
// The packages are no longer bundled with the app — they download on demand
// from the npm registry (npmmirror as fallback, both proxy-aware via the
// global undici dispatcher) into <userData>/ocr-engine/node_modules, and the
// paddle loader imports them from there with a plain file-URL import.
//
// This module is electron-free so vitest can exercise it directly.

export interface EnginePackage {
  name: string
  version: string
}

export interface EnginePackInfo {
  platform: string
  arch: string
  packages: EnginePackage[]
}

/** Bump when the package set changes — installed packs with an older version
 * are treated as absent and re-download. */
export const ENGINE_PACK_VERSION = 1

const BASE_PACKAGES: EnginePackage[] = [
  { name: 'ppu-paddle-ocr', version: '6.4.3' },
  { name: 'ppu-ocv', version: '4.0.0' },
  { name: 'onnxruntime-node', version: '1.29.0' },
  { name: '@napi-rs/canvas', version: '1.0.8' },
  { name: '@techstark/opencv-js', version: '5.0.0-release.1' }
]

// @napi-rs/canvas ships its native binding per platform; exactly one of these
// matches the running app. Keep in sync with canvas's optionalDependencies.
const CANVAS_PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@napi-rs/canvas-win32-x64-msvc',
  'win32-arm64': '@napi-rs/canvas-win32-arm64-msvc',
  'darwin-x64': '@napi-rs/canvas-darwin-x64',
  'darwin-arm64': '@napi-rs/canvas-darwin-arm64',
  'linux-x64': '@napi-rs/canvas-linux-x64-gnu'
}

export function buildEnginePack(platform: string = process.platform, arch: string = process.arch): EnginePackInfo | null {
  const canvasPlatform = CANVAS_PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!canvasPlatform) return null
  return {
    platform,
    arch,
    packages: [...BASE_PACKAGES, { name: canvasPlatform, version: '1.0.8' }]
  }
}

const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']

interface RegistryMeta {
  registry: string
  tarball: string
  integrity: string
  unpackedSize: number | null
}

async function fetchRegistryMeta(pkg: EnginePackage, signal: AbortSignal): Promise<RegistryMeta> {
  let lastError: unknown = null
  for (const registry of REGISTRIES) {
    try {
      const url = `${registry}/${pkg.name}/${pkg.version}`
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      const meta = (await response.json()) as {
        dist?: { tarball?: string; integrity?: string; unpackedSize?: number }
      }
      if (!meta.dist?.tarball || !meta.dist.integrity) throw new Error(`registry response missing dist for ${pkg.name}`)
      return {
        registry,
        tarball: meta.dist.tarball,
        integrity: meta.dist.integrity,
        unpackedSize: typeof meta.dist.unpackedSize === 'number' ? meta.dist.unpackedSize : null
      }
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
    }
  }
  throw new Error(`failed to resolve ${pkg.name}@${pkg.version}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function verifyIntegrity(tarball: Buffer, integrity: string, name: string): void {
  const match = /^sha512-(.+)$/.exec(integrity)
  if (!match) throw new Error(`unsupported integrity format for ${name}`)
  const digest = createHash('sha512').update(tarball).digest('base64')
  if (digest !== match[1]) throw new Error(`integrity mismatch for ${name}`)
}

/** Windows 10 1803+ ships bsdtar; GNU tar from dev environments misparses
 * `C:\...` paths as a remote host, so on Windows only the absolute System32
 * binary is acceptable. */
export function tarBinary(): string {
  if (process.platform === 'win32') {
    const systemTar = 'C:\\Windows\\System32\\tar.exe'
    if (!existsSync(systemTar)) throw new Error('tar.exe not found (Windows 10 1803+ required)')
    return systemTar
  }
  return 'tar'
}

/** Extract `<tgz>` (single `package/` root) into `<dest>/<name>`. */
async function extractPackage(tgz: string, dest: string, name: string): Promise<void> {
  const extractDir = `${dest}.extract`
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarBinary(), ['-xzf', tgz, '-C', extractDir], { windowsHide: true })
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr.trim()}`))))
    })
    const packageDir = join(extractDir, 'package')
    if (!existsSync(packageDir)) throw new Error(`archive for ${name} has no package/ root`)
    const target = join(dest, name)
    const scopeIndex = name.indexOf('/')
    if (scopeIndex > 0) mkdirSync(join(dest, name.slice(0, scopeIndex)), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(packageDir, target)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

export type EngineProgress =
  | { phase: 'download'; index: number; count: number; name: string; receivedBytes: number; totalBytes: number | null }
  | { phase: 'extract'; index: number; count: number; name: string }

export interface EngineState {
  installed: boolean
  packVersion: number
  bytes: number | null
}

function engineMarkerPath(root: string): string {
  return join(root, 'engine.json')
}

export function getEngineState(root: string): EngineState {
  try {
    const marker = JSON.parse(readFileSync(engineMarkerPath(root), 'utf8')) as {
      version?: number
      bytes?: number
    }
    if (typeof marker.version !== 'number') return { installed: false, packVersion: 0, bytes: null }
    return {
      installed: marker.version === ENGINE_PACK_VERSION && existsSync(join(root, 'node_modules', 'ppu-paddle-ocr')),
      packVersion: marker.version,
      bytes: typeof marker.bytes === 'number' ? marker.bytes : null
    }
  } catch {
    return { installed: false, packVersion: 0, bytes: null }
  }
}

/** Absolute path of a package inside the engine pack (no existence check). */
export function engineModulePath(root: string, name: string): string {
  return join(root, 'node_modules', name)
}

/** Best-effort full removal of the engine pack. */
export function deleteEnginePack(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** Download and install the engine pack for the current platform. */
export async function downloadEnginePack(
  root: string,
  onProgress: (progress: EngineProgress) => void,
  signal: AbortSignal
): Promise<EngineState> {
  const pack = buildEnginePack()
  if (!pack) throw new Error(`high-accuracy OCR engine is not available for ${process.platform}-${process.arch}`)

  rmSync(root, { recursive: true, force: true })
  const staging = `${root}.staging`
  rmSync(staging, { recursive: true, force: true })
  const nodeModules = join(staging, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })

  let unpackedBytes = 0
  try {
    for (let index = 0; index < pack.packages.length; index++) {
      const pkg = pack.packages[index]
      const meta = await fetchRegistryMeta(pkg, signal)
      const tgzPath = join(staging, `${index}.tgz`)

      const response = await fetch(meta.tarball, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${pkg.name}`)
      const totalBytes = Number(response.headers.get('content-length')) || null
      const chunks: Buffer[] = []
      let receivedBytes = 0
      let lastReport = 0
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
          chunks.push(chunk)
          receivedBytes += chunk.byteLength
          if (receivedBytes - lastReport > 256 * 1024) {
            lastReport = receivedBytes
            onProgress({ phase: 'download', index, count: pack.packages.length, name: pkg.name, receivedBytes, totalBytes })
          }
        }
      }
      onProgress({ phase: 'download', index, count: pack.packages.length, name: pkg.name, receivedBytes, totalBytes: receivedBytes })

      const tarball = Buffer.concat(chunks)
      verifyIntegrity(tarball, meta.integrity, pkg.name)
      writeFileSync(tgzPath, tarball)
      if (meta.unpackedSize) unpackedBytes += meta.unpackedSize

      onProgress({ phase: 'extract', index, count: pack.packages.length, name: pkg.name })
      await extractPackage(tgzPath, nodeModules, pkg.name)
      rmSync(tgzPath, { force: true })
    }

    writeFileSync(engineMarkerPath(staging), `${JSON.stringify({ version: ENGINE_PACK_VERSION, bytes: unpackedBytes })}\n`, 'utf8')
    renameSync(staging, root)
    return { installed: true, packVersion: ENGINE_PACK_VERSION, bytes: unpackedBytes }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    // A half-installed engine is worse than none — only the marker makes an
    // engine "installed", and it is written last.
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
