// log-rotator 配置（模拟项目，用于 E2E 压缩测试的对话素材）
module.exports = {
  // 单个日志文件超过该大小即触发轮转
  MAX_LOG_SIZE_MB: 48,
  // 保留最近多少份历史日志
  KEEP_RECENT_LOGS: 7,
  // 轮转操作整体超时（毫秒）
  ROTATE_TIMEOUT_MS: 3500,
  // 压缩格式：gzip（此前误用 zip，已修正）
  COMPRESS_FORMAT: 'gzip',
  // 日志文件名格式
  LOG_NAME_PATTERN: 'app-YYYYMMDD-HHmm.log',
  // 存在该锁文件时跳过本轮轮转
  LOCK_FILE: '.rotate.lock'
}
