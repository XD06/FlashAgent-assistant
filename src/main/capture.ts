import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, desktopCapturer, nativeImage, screen } from 'electron'
import type { Display } from 'electron'

// Screen capture backend.
//
// desktopCapturer thumbnails come back upscaled-from-lower-res in some app
// configurations (measured ~4x blurrier than a native CopyFromScreen frame
// at identical moments), so on Windows we use a tiny DPI-aware GDI helper
// instead. The helper .cs is compiled once with the .NET Framework csc.exe
// that ships on every Windows 10/11 install, cached in userData. macOS uses
// the built-in `screencapture` CLI. desktopCapturer stays as the fallback.

const HELPER_CS = `using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class CaptureScreen {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static int Main(string[] args) {
        SetProcessDPIAware();
        if (args.Length < 2) { Console.Error.WriteLine("usage: <out.png> <screenIndex>"); return 2; }
        Screen screen = Screen.AllScreens[int.Parse(args[1])];
        Rectangle bounds = screen.Bounds;
        using (Bitmap bmp = new Bitmap(bounds.Width, bounds.Height)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            }
            bmp.Save(args[0], ImageFormat.Png);
        }
        Console.WriteLine(bounds.Width + "x" + bounds.Height);
        return 0;
    }
}`

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
]

let helperPromise: Promise<string | null> | null = null

/** Compile (once) and return the helper exe path, or null when unavailable. */
function ensureHelper(): Promise<string | null> {
  helperPromise ??= (async () => {
    const csc = CSC_CANDIDATES.find((candidate) => existsSync(candidate))
    if (!csc) return null
    const dir = join(app.getPath('userData'), 'bin')
    const exe = join(dir, 'CaptureScreen.exe')
    if (existsSync(exe)) return exe
    const cs = join(dir, 'CaptureScreen.cs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(cs, HELPER_CS, 'utf8')
    await new Promise<void>((resolve, reject) => {
      execFile(csc, ['/nologo', '/target:exe', `/out:${exe}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', cs], (error) =>
        error ? reject(error) : resolve()
      )
    })
    return exe
  })()
  return helperPromise.catch(() => null)
}

/** .NET orders screens differently from Electron — pick by nearest physical
 * center (Electron bounds are logical; multiply by the scale factor). */
function pickScreenIndex(display: Display): number {
  const cx = (display.bounds.x + display.bounds.width / 2) * display.scaleFactor
  const cy = (display.bounds.y + display.bounds.height / 2) * display.scaleFactor
  let bestIndex = 0
  let bestDist = Number.POSITIVE_INFINITY
  const screens = screen.getAllDisplays()
  // .NET enumerates screens in its own order; we don't have its bounds here,
  // so fall back to the Electron display's position in the array which
  // matches Screen.AllScreens ordering on stock Windows setups.
  const index = screen.getAllDisplays().findIndex((item) => item.id === display.id)
  for (let i = 0; i < Math.max(1, screens.length); i++) {
    const candidate = screens[i]
    const px = (candidate.bounds.x + candidate.bounds.width / 2) * candidate.scaleFactor
    const py = (candidate.bounds.y + candidate.bounds.height / 2) * candidate.scaleFactor
    const dist = Math.hypot(px - cx, py - cy)
    if (dist < bestDist) {
      bestDist = dist
      bestIndex = i
    }
  }
  return index >= 0 ? bestIndex : index
}

async function execCapture(command: string, args: string[], outPath: string, timeoutMs: number): Promise<Electron.NativeImage> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error) => (error ? reject(error) : resolve()))
  })
  const image = nativeImage.createFromPath(outPath)
  if (image.isEmpty()) throw new Error('capture produced an empty image')
  return image
}

/** Capture the given display at native physical resolution. */
export async function captureDisplay(display: Display): Promise<Electron.NativeImage> {
  const tmpPath = join(app.getPath('userData'), 'last-capture.png')
  if (process.platform === 'win32') {
    try {
      const exe = await ensureHelper()
      if (exe) {
        const image = await execCapture(exe, [tmpPath, String(pickScreenIndex(display))], tmpPath, 8000)
        // The helper writes the frame to disk for IPC-free transfer; the file
        // has served its purpose once the pixels are in memory. Left in place
        // it is both a disk leak and a privacy residue (full-screen capture).
        cleanupCaptureTemp()
        return image
      }
    } catch (error) {
      console.warn('[capture] GDI helper failed, falling back to desktopCapturer:', error)
      cleanupCaptureTemp()
    }
  } else if (process.platform === 'darwin') {
    try {
      const index = screen.getAllDisplays().findIndex((item) => item.id === display.id) + 1
      const image = await execCapture('screencapture', ['-x', `-D${index}`, tmpPath], tmpPath, 8000)
      cleanupCaptureTemp()
      return image
    } catch (error) {
      console.warn('[capture] screencapture failed, falling back to desktopCapturer:', error)
      cleanupCaptureTemp()
    }
  }

  // Fallback (also Linux): desktopCapturer at native resolution.
  const { width, height } = display.size
  const scale = display.scaleFactor || 1
  const sources = await desktopCapturerPromise({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  })
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source available')
  return source.thumbnail
}

function desktopCapturerPromise(options: Parameters<typeof desktopCapturer.getSources>[0]): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources(options)
}

export function cleanupCaptureTemp(): void {
  try {
    const tmpPath = join(app.getPath('userData'), 'last-capture.png')
    if (existsSync(tmpPath)) rmSync(tmpPath)
  } catch {
    // Temp file cleanup is best-effort.
  }
}
