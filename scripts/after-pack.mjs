import { spawnSync } from 'node:child_process'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const prebuildFolder = context.arch === 3 ? 'win32-arm64' : 'win32-x64'

  const result = spawnSync(process.execPath, ['scripts/prune-selection-hook-win.js', context.appOutDir, prebuildFolder], {
    stdio: 'inherit',
    cwd: process.cwd()
  })

  if (result.status !== 0) {
    throw new Error(`afterPack prune script failed with status ${result.status ?? 'unknown'}`)
  }
}
