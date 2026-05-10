import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../icons'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'

interface InitPayload {
  imageDataUrl: string
  displayId: number
  width: number
  height: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type OverlayAction = 'explain' | 'save' | 'copy' | 'pin'

function rectFrom(start: { x: number; y: number }, current: { x: number; y: number }): Rect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
  }
}

function OverlayApp() {
  const { settings } = useSettings()
  useThemeMode(settings.theme)
  const isZh = settings.language === 'zh-CN'
  const labels = {
    cancel: isZh ? '取消' : 'Cancel',
    pin: isZh ? '钉住' : 'Pin',
    save: isZh ? '保存' : 'Save',
    copy: isZh ? '复制' : 'Copy',
    explain: isZh ? 'AI 识图' : 'AI Explain',
    hint: isZh ? '拖动鼠标框选区域 · Esc 取消' : 'Drag to select region · Esc to cancel'
  }

  const [init, setInit] = React.useState<InitPayload | null>(null)
  const [start, setStart] = React.useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = React.useState<{ x: number; y: number } | null>(null)
  const [committed, setCommitted] = React.useState<Rect | null>(null)

  React.useEffect(() => {
    const off = window.assistantLite.screenshot.onOverlayInit((payload) => setInit(payload))
    void window.assistantLite.screenshot.overlayReady()
    return off
  }, [])

  const cancel = React.useCallback(() => {
    void window.assistantLite.screenshot.overlayCancel()
  }, [])

  const confirm = React.useCallback(
    (rect: Rect, action: OverlayAction) => {
      if (!init) return
      if (rect.width < 4 || rect.height < 4) return
      void window.assistantLite.screenshot.overlayConfirm({
        displayId: init.displayId,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        action
      })
    },
    [init]
  )

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
      else if (event.key === 'Enter' && committed) confirm(committed, 'explain')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, confirm, committed])

  if (!init) return null

  const drafting = start && current ? rectFrom(start, current) : null
  const rect = drafting ?? committed

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    setCommitted(null)
    setStart({ x: event.clientX, y: event.clientY })
    setCurrent({ x: event.clientX, y: event.clientY })
  }
  const onMouseMove = (event: React.MouseEvent) => {
    if (!start) return
    setCurrent({ x: event.clientX, y: event.clientY })
  }
  const onMouseUp = (event: React.MouseEvent) => {
    if (!start) return
    const finalRect = rectFrom(start, { x: event.clientX, y: event.clientY })
    setStart(null)
    setCurrent(null)
    if (finalRect.width < 4 || finalRect.height < 4) {
      setCommitted(null)
      return
    }
    setCommitted(finalRect)
  }

  // Compute mask pieces (top / right / bottom / left around rect)
  const maskPieces = (() => {
    if (!rect) return null
    const W = init.width
    const H = init.height
    return [
      { left: 0, top: 0, width: W, height: rect.y },
      { left: 0, top: rect.y + rect.height, width: W, height: Math.max(0, H - rect.y - rect.height) },
      { left: 0, top: rect.y, width: rect.x, height: rect.height },
      {
        left: rect.x + rect.width,
        top: rect.y,
        width: Math.max(0, W - rect.x - rect.width),
        height: rect.height
      }
    ]
  })()

  // Toolbar position: prefer below the rect, fall back to above
  const toolbarStyle = (() => {
    if (!rect) return null
    const TOOLBAR_H = 40
    const PAD = 8
    const belowSpace = init.height - (rect.y + rect.height)
    const showBelow = belowSpace >= TOOLBAR_H + PAD
    const top = showBelow ? rect.y + rect.height + PAD : Math.max(PAD, rect.y - TOOLBAR_H - PAD)
    // align right edge to rect right edge, but keep within viewport
    const right = Math.max(PAD, init.width - (rect.x + rect.width))
    return { top, right }
  })()

  return (
    <div
      className="screenshot-overlay"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={(e) => {
        e.preventDefault()
        cancel()
      }}>
      <img className="screenshot-overlay__bg" src={init.imageDataUrl} alt="" draggable={false} />
      {!rect && <div className="screenshot-overlay__mask" />}
      {maskPieces?.map((piece, i) => (
        <div
          key={i}
          className="screenshot-overlay__mask"
          style={{
            position: 'absolute',
            inset: 'auto',
            left: piece.left,
            top: piece.top,
            width: piece.width,
            height: piece.height
          }}
        />
      ))}
      {rect && (
        <div
          className="screenshot-overlay__rect"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
          <div className="screenshot-overlay__rect-size">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </div>
      )}
      {committed && toolbarStyle && (
        <div
          className="toolbar-root screenshot-overlay__toolbar"
          style={toolbarStyle}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}>
          <button className="toolbar-button" onClick={cancel} title={labels.cancel}>
            <Icon name="x" />
            <span>{labels.cancel}</span>
          </button>
          <button
            className="toolbar-button"
            onClick={() => confirm(committed, 'pin')}
            title={labels.pin}>
            <Icon name="pin" />
            <span>{labels.pin}</span>
          </button>
          <button
            className="toolbar-button"
            onClick={() => confirm(committed, 'save')}
            title={labels.save}>
            <Icon name="download" />
            <span>{labels.save}</span>
          </button>
          <button
            className="toolbar-button"
            onClick={() => confirm(committed, 'copy')}
            title={labels.copy}>
            <Icon name="copy" />
            <span>{labels.copy}</span>
          </button>
          <button
            className="toolbar-button toolbar-button--primary"
            onClick={() => confirm(committed, 'explain')}
            title={labels.explain}>
            <Icon name="sparkles" />
            <span>{labels.explain}</span>
          </button>
        </div>
      )}
      {!committed && <div className="screenshot-overlay__hint">{labels.hint}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
)
