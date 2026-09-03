import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_PACK_VERSION,
  buildEnginePack,
  deleteEnginePack,
  getEngineState,
  downloadEnginePack,
  tarBinary
} from './enginePack'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('buildEnginePack', () => {
  it('maps win32/x64 to the win32 canvas binary', () => {
    const pack = buildEnginePack('win32', 'x64')
    expect(pack).not.toBeNull()
    expect(pack!.packages.map((pkg) => pkg.name)).toContain('@napi-rs/canvas-win32-x64-msvc')
    expect(pack!.packages.map((pkg) => pkg.name)).toContain('ppu-paddle-ocr')
  })

  it('maps darwin/arm64 to the arm64 canvas binary', () => {
    const pack = buildEnginePack('darwin', 'arm64')
    expect(pack!.packages.map((pkg) => pkg.name)).toContain('@napi-rs/canvas-darwin-arm64')
  })

  it('returns null for unsupported platforms', () => {
    expect(buildEnginePack('freebsd', 'x64')).toBeNull()
  })
})

describe('getEngineState', () => {
  it('treats a missing directory as not installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-pack-'))
    dirs.push(dir)
    expect(getEngineState(join(dir, 'engine'))).toEqual({ installed: false, packVersion: 0, bytes: null })
  })

  it('requires both the marker and the package tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-pack-'))
    dirs.push(root)
    writeFileSync(join(root, 'engine.json'), JSON.stringify({ version: ENGINE_PACK_VERSION, bytes: 42 }))
    expect(getEngineState(root).installed).toBe(false)

    await mkdirSync(join(root, 'node_modules', 'ppu-paddle-ocr'), { recursive: true })
    expect(getEngineState(root)).toEqual({ installed: true, packVersion: ENGINE_PACK_VERSION, bytes: 42 })
  })

  it('treats an outdated marker as not installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-pack-'))
    dirs.push(root)
    await mkdirSync(join(root, 'node_modules', 'ppu-paddle-ocr'), { recursive: true })
    writeFileSync(join(root, 'engine.json'), JSON.stringify({ version: ENGINE_PACK_VERSION - 1 }))
    expect(getEngineState(root).installed).toBe(false)
  })
})

describe('downloadEnginePack', () => {
  it('an aborted download leaves no residue behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-pack-'))
    dirs.push(root)
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadEnginePack(join(root, 'engine'), () => undefined, controller.signal)
    ).rejects.toThrow()
    expect(existsSync(join(root, 'engine'))).toBe(false)
    expect(existsSync(join(root, 'engine.staging'))).toBe(false)
  })
})

describe('tar extraction pipeline', () => {
  // The real download resolves tarballs from the registry; this exercises the
  // same `package/` root contract with locally built archives (tar ships with
  // Windows 10 1803+, macOS and CI).
  it('unpacks plain and scoped package roots', async () => {
    const work = await mkdtemp(join(tmpdir(), 'engine-tar-'))
    dirs.push(work)
    const pkgDir = join(work, 'pkg')
    const scopedDir = join(work, 'scoped')
    await mkdirSync(join(pkgDir, 'package'), { recursive: true })
    await mkdirSync(join(scopedDir, 'package', 'sub'), { recursive: true })
    await writeFile(join(pkgDir, 'package', 'index.js'), 'module.exports = 1')
    await writeFile(join(scopedDir, 'package', 'sub', 'native.node'), 'binary-ish')

    execFileSync(tarBinary(), ['-czf', join(work, 'plain.tgz'), '-C', pkgDir, 'package'])
    execFileSync(tarBinary(), ['-czf', join(work, 'scoped.tgz'), '-C', scopedDir, 'package'])

    const nodeModules = join(work, 'node_modules')
    await mkdirSync(nodeModules, { recursive: true })
    execFileSync(tarBinary(), ['-xzf', join(work, 'plain.tgz'), '-C', nodeModules])
    execFileSync(tarBinary(), ['-xzf', join(work, 'scoped.tgz'), '-C', nodeModules])
    expect(existsSync(join(nodeModules, 'package', 'index.js'))).toBe(true)
    expect(existsSync(join(nodeModules, 'package', 'sub', 'native.node'))).toBe(true)
  })
})

describe('deleteEnginePack', () => {
  it('removes the engine root entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-pack-'))
    await mkdirSync(join(root, 'ocr-engine', 'node_modules'), { recursive: true })
    deleteEnginePack(join(root, 'ocr-engine'))
    expect(existsSync(join(root, 'ocr-engine'))).toBe(false)
  })
})
