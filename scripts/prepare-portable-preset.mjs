import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Build a shareable portable bundle: copy a whitelist of the local userData
 * profile into dist/data/, which the portable build uses as its userData dir.
 * Chat history, vocabulary, caches and native helper binaries are deliberately
 * excluded — they are personal data or machine-specific build artifacts.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distDir = join(root, 'dist')
const targetDir = join(distDir, 'data')

const fromFlag = process.argv.indexOf('--from')
const sourceDir =
  fromFlag >= 0 && process.argv[fromFlag + 1]
    ? resolve(process.argv[fromFlag + 1])
    : join(process.env.APPDATA ?? '', 'flashagent-assistant')

const portableExe = existsSync(distDir)
  ? readdirSync(distDir).find((name) => /^FlashAgent-assistant-Portable-.*\.exe$/i.test(name))
  : undefined
if (!portableExe) {
  console.error('[preset] dist/ 里没有 portable exe，请先运行 pnpm dist:win（或直接用 pnpm dist:win:share）。')
  process.exit(1)
}

const settingsPath = join(sourceDir, 'settings.json')
if (!existsSync(settingsPath)) {
  console.error(`[preset] 找不到 ${settingsPath}，请用 --from 指定含 settings.json 的用户数据目录。`)
  process.exit(1)
}

// dist/data is owned by this script: rebuild it so a stale preset from an
// earlier run (e.g. a skills folder since removed) never leaks into a new
// share package.
rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
const adjusted = []
if (settings && typeof settings === 'object' && settings.settings && typeof settings.settings === 'object') {
  const value = settings.settings
  // Values that point at this machine would break or surprise on another PC.
  if (value.proxyUrl) {
    value.proxyUrl = ''
    adjusted.push('proxyUrl（清空本机代理地址）')
  }
  if (Array.isArray(value.linkedSkillDirs) && value.linkedSkillDirs.length) {
    value.linkedSkillDirs = []
    adjusted.push('linkedSkillDirs（清空本机绝对路径）')
  }
  if (value.autoLaunch) {
    value.autoLaunch = false
    adjusted.push('autoLaunch（不写对方开机自启）')
  }
  // The shipped default keeps selection listening off; a share package should
  // work the moment it is opened.
  if (value.enabled === false) {
    value.enabled = true
    adjusted.push('enabled（开启划词，开箱即用）')
  }
}
writeFileSync(join(targetDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

const copied = ['settings.json']
for (const name of ['memory.md']) {
  const src = join(sourceDir, name)
  if (existsSync(src) && statSync(src).isFile()) {
    cpSync(src, join(targetDir, name))
    copied.push(name)
  }
}
// A skill folder may be a git checkout with build caches; only ship what the
// agent can actually read (SKILL.md plus its scripts/references).
const SKIP_NAMES = new Set(['.git', '__pycache__', 'node_modules', '.DS_Store'])
for (const name of ['skills']) {
  const src = join(sourceDir, name)
  if (existsSync(src) && statSync(src).isDirectory()) {
    cpSync(src, join(targetDir, name), {
      recursive: true,
      filter: (source) => {
        const base = basename(source)
        return !SKIP_NAMES.has(base) && !/\.(pyc|pyo|bak)$/i.test(base)
      }
    })
    copied.push(`${name}/`)
  }
}

console.log(`[preset] 已生成 ${targetDir}`)
console.log(`[preset] 随包文件: ${copied.join(', ')}`)
if (adjusted.length) {
  console.log(`[preset] 已调整: ${adjusted.join('、')}`)
}
console.log('[preset] 分发时请把 exe 与 data/ 一起压缩；data/settings.json 含 API Key，请只发给信任的人。')
