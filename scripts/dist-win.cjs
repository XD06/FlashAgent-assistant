/**
 * Wrapper around electron-builder that handles the winCodeSign symlink issue.
 *
 * Strategy:
 * 1. Run electron-builder. It will download winCodeSign.7z and fail to extract
 *    due to symlink errors.
 * 2. Run fix-winCodeSign.cjs to manually extract and fix the symlinks.
 * 3. Run electron-builder again — it will find the cached and extracted files.
 */
const { spawn } = require('node:child_process')
const { execFileSync } = require('node:child_process')

delete process.env.ELECTRON_RUN_AS_NODE

// electron-builder packs 7z archives with 7za -mx=9, which needs ~1GB of
// commit memory and fails on constrained machines ("Can't allocate required
// memory"). Default to a low level unless explicitly overridden — see
// ELECTRON_BUILDER_COMPRESSION_LEVEL in app-builder-lib targets/archive.js.
if (!process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL) {
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
}

const args = process.argv.slice(2)
if (args.length === 0) {
  args.push('--win', 'portable', '--x64', '--publish', 'never')
}

console.log('[dist-helper] First pass — let electron-builder download winCodeSign...')
const firstPass = spawn('npx', ['electron-builder', ...args], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})

firstPass.on('exit', (code) => {
  if (code === 0) {
    console.log('[dist-helper] First pass succeeded, done!')
    process.exit(0)
  }

  console.log('[dist-helper] First pass failed, running winCodeSign fix...')
  try {
    execFileSync('node', ['scripts/fix-winCodeSign.cjs'], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
  } catch (e) {
    console.error('[dist-helper] fix-winCodeSign failed:', e.message)
  }

  console.log('[dist-helper] Second pass — retrying electron-builder with fixed cache...')
  const secondPass = spawn('npx', ['electron-builder', ...args], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  })

  secondPass.on('exit', (code2) => {
    process.exit(code2 ?? 1)
  })
})
