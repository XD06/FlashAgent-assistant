import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Windows.Media.Ocr helper — the system OCR engine, wrapped in a tiny exe
// compiled on demand with the .NET Framework csc.exe that ships with every
// Windows 10/11 install (same zero-dependency trick as the screen-capture
// helper in src/main/capture.ts).
//
// The helper reads a PNG from stdin, upscales small images 2x with bicubic
// interpolation (WinRT OCR misreads small glyphs — 2x fixed several error
// classes in testing, see docs/archive/2026-09-03-ocr-winrt-test-result.md) and prints the recognized
// lines as UTF-8. `--list-langs` prints the installed recognizer tags.
//
// WinRT interop notes: the helper deliberately avoids the await extensions in
// System.Runtime.WindowsRuntime.dll — their type identities were compiled
// against the monolithic Windows.winmd (Windows 8 layout) and no longer unify
// with the per-namespace winmd files on Windows 10/11. Async operations are
// instead awaited via their Completed event + GetResults(), so the only
// references needed are the five winmd files plus System.Drawing.
//
// This module must stay free of electron imports so vitest can exercise the
// compile/run pipeline directly.

const WINRT_OCR_CS = `using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

class WinRtOcr
{
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        try
        {
            if (args.Length >= 1 && args[0] == "--list-langs")
            {
                ListLangs();
                return 0;
            }
            if (args.Length < 1 || args[0] != "-")
            {
                Console.Error.WriteLine("usage: - [langTag]  (PNG bytes on stdin)");
                return 2;
            }
            OcrEngine engine = CreateEngine(args.Length >= 2 ? args[1] : null);
            if (engine == null)
            {
                Console.Error.WriteLine("no OCR recognizer installed");
                return 3;
            }
            string text = Recognize(engine);
            Console.Out.Write(text);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    static void ListLangs()
    {
        var langs = OcrEngine.AvailableRecognizerLanguages;
        for (int i = 0; i < langs.Count; i++) Console.WriteLine(langs[i].LanguageTag);
    }

    // Blocking wait over a WinRT async operation. The helper is a short-lived
    // console process with no sync context, so parking the main thread is safe.
    static T WaitFor<T>(IAsyncOperation<T> operation)
    {
        using (ManualResetEvent done = new ManualResetEvent(false))
        {
            operation.Completed = delegate { done.Set(); };
            done.WaitOne();
            if (operation.Status != AsyncStatus.Completed)
            {
                throw new Exception("WinRT operation ended with status " + operation.Status);
            }
            return operation.GetResults();
        }
    }

    static OcrEngine CreateEngine(string preferredTag)
    {
        if (!string.IsNullOrEmpty(preferredTag))
        {
            OcrEngine preferred = OcrEngine.TryCreateFromLanguage(new Language(preferredTag));
            if (preferred != null) return preferred;
        }
        OcrEngine profile = OcrEngine.TryCreateFromUserProfileLanguages();
        if (profile != null) return profile;
        var available = OcrEngine.AvailableRecognizerLanguages;
        if (available.Count > 0) return OcrEngine.TryCreateFromLanguage(available[0]);
        return null;
    }

    static string Recognize(OcrEngine engine)
    {
        byte[] png;
        using (MemoryStream raw = new MemoryStream())
        {
            Console.OpenStandardInput().CopyTo(raw);
            png = raw.ToArray();
        }
        using (Bitmap source = new Bitmap(new MemoryStream(png)))
        {
            // Small glyphs are the dominant error source; 2x bicubic upsampling
            // fixed several classes of misreads in testing. Large captures are
            // left alone to keep recognition fast.
            int maxDim = Math.Max(source.Width, source.Height);
            double scale = maxDim <= 1600 ? 2.0 : 1.0;
            using (Bitmap input = Upscale(source, scale))
            using (MemoryStream encoded = new MemoryStream())
            {
                input.Save(encoded, ImageFormat.Png);
                using (SoftwareBitmap bitmap = DecodePng(encoded.ToArray()))
                {
                    SoftwareBitmap target = bitmap;
                    if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8)
                    {
                        target = SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8);
                    }
                    using (target)
                    {
                        OcrResult result = WaitFor(engine.RecognizeAsync(target));
                        StringBuilder text = new StringBuilder();
                        if (result != null && result.Lines != null)
                        {
                            foreach (OcrLine line in result.Lines)
                            {
                                if (line == null || string.IsNullOrEmpty(line.Text)) continue;
                                text.AppendLine(line.Text.Trim());
                            }
                        }
                        return text.ToString();
                    }
                }
            }
        }
    }

    static SoftwareBitmap DecodePng(byte[] png)
    {
        using (InMemoryRandomAccessStream stream = new InMemoryRandomAccessStream())
        {
            DataWriter writer = new DataWriter(stream);
            writer.WriteBytes(png);
            WaitFor(writer.StoreAsync());
            WaitFor(writer.FlushAsync());
            writer.DetachStream();
            stream.Seek(0);
            BitmapDecoder decoder = WaitFor(BitmapDecoder.CreateAsync(stream));
            return WaitFor(decoder.GetSoftwareBitmapAsync());
        }
    }

    static Bitmap Upscale(Bitmap source, double scale)
    {
        int width = (int)Math.Round(source.Width * scale);
        int height = (int)Math.Round(source.Height * scale);
        Bitmap target = new Bitmap(width, height);
        using (Graphics g = Graphics.FromImage(target))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(source, 0, 0, width, height);
        }
        return target;
    }
}`

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
]

// Windows 8 shipped one monolithic Windows.winmd; Windows 10/11 splits WinRT
// metadata per namespace. These cover everything the helper touches
// (Language, BitmapDecoder/SoftwareBitmap, OcrEngine, IRandomAccessStream).
const WINMD_DIR = 'C:\\Windows\\System32\\WinMetadata'
const WINMD_REFS = [
  'Windows.Foundation.winmd',
  'Windows.Globalization.winmd',
  'Windows.Graphics.winmd',
  'Windows.Media.winmd',
  'Windows.Storage.winmd'
]

export function findCsc(): string | null {
  return CSC_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

/** System OCR needs Windows + the framework csc compiler + the WinRT metadata. */
export function isWinRtSupported(): boolean {
  return (
    process.platform === 'win32' &&
    !!findCsc() &&
    WINMD_REFS.every((ref) => existsSync(join(WINMD_DIR, ref)))
  )
}

/** Compile (once) the WinRT OCR helper into `dir`; returns the exe path. */
export async function compileWinRtOcr(dir: string): Promise<string> {
  const csc = findCsc()
  if (!csc) throw new Error('.NET Framework csc.exe not found')

  const exe = join(dir, 'WinRtOcr.exe')
  if (existsSync(exe)) return exe
  mkdirSync(dir, { recursive: true })
  const cs = join(dir, 'WinRtOcr.cs')
  writeFileSync(cs, WINRT_OCR_CS, 'utf8')
  const refs = [
    '/r:System.Drawing.dll',
    // Referencing winmd metadata drags in System.Attribute from the
    // System.Runtime facade — CS0012 without it.
    `/r:${join(dirname(csc), 'System.Runtime.dll')}`,
    ...WINMD_REFS.map((ref) => `/r:${join(WINMD_DIR, ref)}`)
  ]
  try {
    await execHelper(csc, ['/nologo', '/target:exe', `/out:${exe}`, ...refs, cs])
  } catch (error) {
    throw new Error(`csc failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return exe
}

function execHelper(exe: string, args: string[], input?: Buffer, timeoutMs = 30_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`OCR helper timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      // csc writes diagnostics to stdout; helpers write to stderr.
      else reject(new Error(String(stderr || stdout || `OCR helper exited with code ${code}`).trim()))
    })
    child.stdin.end(input)
  })
}

/** Recognize a PNG buffer; returns raw helper text (UTF-8, line per line). */
export function runWinRtOcr(exe: string, png: Buffer, langTag: string | null): Promise<string> {
  const args = ['-']
  if (langTag) args.push(langTag)
  return execHelper(exe, args, png)
}

/** List installed recognizer language tags (e.g. en-US, zh-Hans-CN). */
export function runWinRtOcrLangs(exe: string): Promise<string[]> {
  return execHelper(exe, ['--list-langs']).then((stdout) =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
}
