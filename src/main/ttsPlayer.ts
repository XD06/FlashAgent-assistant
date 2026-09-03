import { BrowserWindow } from 'electron'
import type { AppSettings } from '@shared/types'
import { synthesizeSpeech } from './translate/tts'
import { showResultToast } from './toast'
import type { ProviderFetch } from './ai/OpenAICompatibleClient'

// Unified speech playback for every "朗读" entry point (selection toolbar,
// type-in actions, translate window). Text is synthesized through the
// configured OpenAI-compatible TTS endpoint and played in a hidden player
// window so playback survives closing the window that requested it.

const TTS_TIMEOUT_MS = 30_000

let player: BrowserWindow | null = null

function getPlayer(): BrowserWindow {
  if (player && !player.isDestroyed()) return player
  player = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: { sandbox: true, nodeIntegration: false }
  })
  player.on('closed', () => {
    player = null
  })
  void player.loadURL('data:text/html,<html><body></body></html>')
  return player
}

export function destroyTtsPlayer(): void {
  if (player && !player.isDestroyed()) player.destroy()
  player = null
}

/** Synthesize and play the text. Resolves true when playback started. */
export async function playTts(text: string, getSettings: () => AppSettings, fetchImpl: ProviderFetch): Promise<boolean> {
  const isZh = getSettings().language === 'zh-CN'
  try {
    const dataUrl = await synthesizeSpeech(text, getSettings().tts, fetchImpl, AbortSignal.timeout(TTS_TIMEOUT_MS))
    const win = getPlayer()
    return await win.webContents.executeJavaScript(
      `(function () {
        if (window.__faAudio) { window.__faAudio.pause(); }
        const audio = new Audio(${JSON.stringify(dataUrl)});
        window.__faAudio = audio;
        return audio.play().then(() => true).catch(() => false);
      })()`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showResultToast(
      isZh ? '语音合成失败' : 'Speech failed',
      isZh
        ? `${message}（请检查设置 → 翻译 中的合成端点/网络）`
        : `${message} (check the TTS endpoint in Settings → Translation)`,
      'error'
    )
    return false
  }
}

/** Stop any ongoing playback. */
export async function stopTtsPlayback(): Promise<void> {
  if (!player || player.isDestroyed()) return
  await player.webContents.executeJavaScript(
    'if (window.__faAudio) { window.__faAudio.pause(); } true'
  ).catch(() => undefined)
}
