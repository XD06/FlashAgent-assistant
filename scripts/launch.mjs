/**
 * Launcher script that clears ELECTRON_RUN_AS_NODE before running electron-vite.
 * This env var is sometimes set by IDE/terminal tools (e.g. CatPaw) and causes
 * Electron to run as a plain Node.js process, breaking the app.
 *
 * Usage: node scripts/launch.mjs dev|preview
 */
import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE

const mode = process.argv[2] || 'dev'
const child = spawn('npx', ['electron-vite', mode], {
  stdio: 'inherit',
  shell: true,
  env: process.env
})

child.on('exit', (code) => process.exit(code ?? 0))
