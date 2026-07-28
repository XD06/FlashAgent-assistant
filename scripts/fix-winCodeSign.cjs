/**
 * Pre-extracts winCodeSign 7z to bypass the symlink creation error on Windows
 * without admin/developer mode. Run this before electron-builder.
 *
 * The app-builder binary (Rust) downloads winCodeSign.7z and extracts it with
 * `7za x -snld`, which fails because Windows refuses to create symlinks without
 * admin or developer mode. This script intercepts by pre-extracting with `7za x -y`
 * (ignoring symlink errors) and then copying the target files as regular files
 * to replace the missing symlinks.
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

const cacheDir = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
const sevenZip = require('7zip-bin').path7za

// electron-builder downloads to a random temp name, extracts to a random temp
// dir and only renames it to this on success — so we must extract into the
// final expected directory name ourselves.
const FINAL_NAME = 'winCodeSign-2.6.0'

if (!existsSync(cacheDir)) {
  console.log('[winCodeSign-fix] No cache directory found, skipping.')
  process.exit(0)
}

function fixSymlinks(targetDir) {
  // The two dylib symlinks 7za fails to create — copy the real files instead
  const dylibDir = join(targetDir, 'darwin', '10.12', 'lib')
  if (!existsSync(dylibDir)) return
  const fixes = [
    { link: join(dylibDir, 'libcrypto.dylib'), real: join(dylibDir, 'libcrypto.1.1.dylib') },
    { link: join(dylibDir, 'libssl.dylib'), real: join(dylibDir, 'libssl.1.1.dylib') },
  ]
  for (const { link, real } of fixes) {
    if (existsSync(real) && !existsSync(link)) {
      copyFileSync(real, link)
      console.log(`[winCodeSign-fix] Created ${link} as copy of ${real}`)
    }
  }
}

const finalDir = join(cacheDir, FINAL_NAME)
const archives = readdirSync(cacheDir).filter((f) => f.endsWith('.7z'))

if (existsSync(join(finalDir, 'windows-10'))) {
  console.log(`[winCodeSign-fix] ${FINAL_NAME} already extracted.`)
  fixSymlinks(finalDir)
} else if (archives.length === 0) {
  console.log('[winCodeSign-fix] No archives found to extract.')
} else {
  const archive = archives[0]
  console.log(`[winCodeSign-fix] Extracting ${archive} -> ${FINAL_NAME}...`)
  mkdirSync(finalDir, { recursive: true })
  try {
    execFileSync(sevenZip, ['x', '-bd', '-y', join(cacheDir, archive), `-o${finalDir}`], {
      stdio: 'pipe', // suppress error output
    })
  } catch {
    // Ignore symlink errors — 7za returns non-zero but files are extracted
  }
  fixSymlinks(finalDir)
  console.log(`[winCodeSign-fix] Done: ${FINAL_NAME}`)
}

// Clean up leftover random-named downloads/dirs from failed builder attempts
for (const entry of readdirSync(cacheDir)) {
  if (entry === FINAL_NAME) continue
  const p = join(cacheDir, entry)
  try {
    if (entry.endsWith('.7z')) unlinkSync(p)
    else rmSync(p, { recursive: true, force: true })
    console.log(`[winCodeSign-fix] Removed leftover ${entry}`)
  } catch {}
}

console.log('[winCodeSign-fix] All done.')
