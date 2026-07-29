// log-rotator 主逻辑（模拟项目）。rotate() 在超大目录下会超时 —— 这是
// 模拟对话中"用户报的 bug"，修复过程构成被压缩的对话历史。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const cfg = require('./config')

function listLogs(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f, stat: fs.statSync(path.join(dir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
}

async function rotate(dir) {
  if (fs.existsSync(path.join(dir, cfg.LOCK_FILE))) return { skipped: true }
  const logs = listLogs(dir)
  const oversized = logs.filter((l) => l.stat.size > cfg.MAX_LOG_SIZE_MB * 1024 * 1024)
  for (const log of oversized) {
    const src = path.join(dir, log.name)
    const gz = zlib.createGzip()
    await new Promise((resolve, reject) => {
      fs.createReadStream(src)
        .pipe(gz)
        .pipe(fs.createWriteStream(`${src}.gz`))
        .on('finish', resolve)
        .on('error', reject)
    })
    fs.unlinkSync(src)
  }
  const remain = listLogs(dir)
  for (const stale of remain.slice(cfg.KEEP_RECENT_LOGS)) {
    fs.unlinkSync(path.join(dir, stale.name))
  }
  return { rotated: oversized.length }
}

module.exports = { rotate, listLogs }
