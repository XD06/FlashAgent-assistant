import { BrowserWindow, screen } from 'electron'

// Small in-app result toast: a pill near the bottom of the screen (same
// language as the vocabulary-book toast) that never steals focus and fades
// out on its own.

let toastWindow: BrowserWindow | null = null
let toastTimer: NodeJS.Timeout | null = null

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function showResultToast(title: string, body: string, tone: 'ok' | 'error'): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  if (toastTimer) clearTimeout(toastTimer)
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy()

  const width = Math.min(460, display.workArea.width - 40)
  const color = tone === 'ok' ? '#0f8f70' : '#c2352b'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { background: transparent; overflow: hidden; }
    .toast { display: flex; align-items: center; gap: 8px; max-width: 100%;
      padding: 8px 16px; border: 1px solid rgba(128,128,128,.35); border-radius: 999px;
      background: rgba(245,245,244,.96); color: #1e1e1c; font: 12px/1.45 'Segoe UI', sans-serif;
      box-shadow: 0 7px 14px rgba(0,0,0,.14); }
    .dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: ${color}; }
    .title { font-weight: 650; margin-right: 2px; }
    .body { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #55554f; }
  </style></head><body>
    <div class="toast"><span class="dot"></span><span class="title">${escapeHtml(title)}</span><span class="body">${escapeHtml(body)}</span></div>
  </body></html>`

  toastWindow = new BrowserWindow({
    width,
    height: 56,
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + display.workArea.height - 96,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false }
  })
  toastWindow.setAlwaysOnTop(true, 'screen-saver')
  toastWindow.on('closed', () => {
    toastWindow = null
  })
  void toastWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  toastWindow.once('ready-to-show', () => {
    if (!toastWindow || toastWindow.isDestroyed()) return
    toastWindow.showInactive()
    toastWindow.setOpacity(1)
    toastTimer = setTimeout(() => {
      if (toastWindow && !toastWindow.isDestroyed()) {
        toastWindow.close()
        toastWindow = null
      }
    }, 2400)
  })
}
