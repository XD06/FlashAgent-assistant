import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'

function PinApp() {
  const [src, setSrc] = React.useState<string>('')

  React.useEffect(() => {
    const off = window.assistantLite.screenshot.onPinInit((payload) => setSrc(payload.imageDataUrl))
    return off
  }, [])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.assistantLite.windowControls.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- Wheel zoom ----
  // We accumulate deltaY into a ref and flush once per animation frame.
  // This avoids dropping the burst of small wheel events macOS trackpads
  // generate (which the previous "one in-flight IPC at a time" lock would
  // throw away) while still keeping IPC traffic bounded.
  const wheelAccum = React.useRef(0)
  const wheelRaf = React.useRef<number | null>(null)
  const flushWheel = React.useCallback(() => {
    wheelRaf.current = null
    const dy = wheelAccum.current
    wheelAccum.current = 0
    if (dy === 0) return
    void window.assistantLite.screenshot.pinZoom(dy)
  }, [])
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (event: WheelEvent) => {
      event.preventDefault()
      wheelAccum.current += event.deltaY
      if (wheelRaf.current === null) {
        wheelRaf.current = window.requestAnimationFrame(flushWheel)
      }
    }
    // passive:false so preventDefault() is honored and we don't get the
    // "Unable to preventDefault inside passive event listener" warning.
    el.addEventListener('wheel', handler, { passive: false })
    return () => {
      el.removeEventListener('wheel', handler)
      if (wheelRaf.current !== null) {
        window.cancelAnimationFrame(wheelRaf.current)
        wheelRaf.current = null
      }
    }
    // Re-run after `src` arrives: the container <div> only mounts once we
    // have an image (see early `return null` below), so the first effect run
    // sees `containerRef.current === null` and bails.
  }, [flushWheel, src])

  // ---- Manual window drag ----
  // We can't use -webkit-app-region: drag because it would also swallow the
  // wheel events we need for zoom. Implement drag in JS via screenX/screenY
  // deltas, batched per animation frame to avoid IPC flooding.
  const dragging = React.useRef(false)
  const lastScreen = React.useRef({ x: 0, y: 0 })
  const pending = React.useRef({ x: 0, y: 0 })
  const rafId = React.useRef<number | null>(null)

  const flush = React.useCallback(() => {
    rafId.current = null
    const { x, y } = pending.current
    if (x === 0 && y === 0) return
    pending.current = { x: 0, y: 0 }
    void window.assistantLite.screenshot.pinMove(x, y)
  }, [])
  const schedule = React.useCallback(() => {
    if (rafId.current !== null) return
    rafId.current = window.requestAnimationFrame(flush)
  }, [flush])

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    dragging.current = true
    lastScreen.current = { x: event.screenX, y: event.screenY }
    // Capture subsequent moves on window so we still track when the cursor
    // briefly leaves the image (e.g. while the OS catches up with setPosition).
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  const onWindowMouseMove = React.useCallback((event: MouseEvent) => {
    if (!dragging.current) return
    const dx = event.screenX - lastScreen.current.x
    const dy = event.screenY - lastScreen.current.y
    if (dx === 0 && dy === 0) return
    lastScreen.current = { x: event.screenX, y: event.screenY }
    pending.current.x += dx
    pending.current.y += dy
    schedule()
  }, [schedule])

  const onWindowMouseUp = React.useCallback(() => {
    dragging.current = false
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    if (rafId.current !== null) {
      window.cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
    flush()
  }, [flush, onWindowMouseMove])

  React.useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      if (rafId.current !== null) {
        window.cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
    }
  }, [onWindowMouseMove, onWindowMouseUp])

  if (!src) return null
  return (
    <div
      ref={containerRef}
      className="screenshot-pin"
      onMouseDown={onMouseDown}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.assistantLite.screenshot.pinMenu()
      }}>
      <img className="screenshot-pin__img" src={src} alt="" draggable={false} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PinApp />
  </React.StrictMode>
)
