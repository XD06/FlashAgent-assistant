import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function removeIfExists(target) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
}

const appOutDir = process.argv[2]
const prebuildFolder = process.argv[3] || 'win32-x64'

if (!appOutDir) {
  console.error('[prune-selection-hook-win] missing appOutDir argument')
  process.exit(1)
}

const selectionHookDir = join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'selection-hook')

if (!existsSync(selectionHookDir)) {
  console.log('[prune-selection-hook-win] selection-hook directory not found, skipping')
  process.exit(0)
}

removeIfExists(join(selectionHookDir, 'docs'))
removeIfExists(join(selectionHookDir, 'src'))
removeIfExists(join(selectionHookDir, 'CLAUDE.md'))
removeIfExists(join(selectionHookDir, 'README.md'))
removeIfExists(join(selectionHookDir, 'README.zh-CN.md'))
removeIfExists(join(selectionHookDir, '.clang-format-ignore'))
removeIfExists(join(selectionHookDir, 'build'))

const prebuildsDir = join(selectionHookDir, 'prebuilds')
if (existsSync(prebuildsDir)) {
  for (const entry of readdirSync(prebuildsDir)) {
    if (entry !== prebuildFolder) removeIfExists(join(prebuildsDir, entry))
  }
}

console.log(`[prune-selection-hook-win] pruned selection-hook package for ${prebuildFolder}`)
