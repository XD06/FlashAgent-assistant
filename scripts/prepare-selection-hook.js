import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const buildDir = join(process.cwd(), 'node_modules', 'selection-hook', 'build')

if (existsSync(buildDir)) {
  rmSync(buildDir, { recursive: true, force: true })
  console.log(`[prepare-selection-hook] removed ${buildDir}`)
} else {
  console.log('[prepare-selection-hook] no local build directory found')
}
