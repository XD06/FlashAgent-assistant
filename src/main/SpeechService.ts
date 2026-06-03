import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

type SpeechCommand = {
  command: string
  args: string[]
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'ignore', 'ignore']; windowsHide: boolean }
) => ChildProcess

const WINDOWS_SPEAK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
if (-not [string]::IsNullOrWhiteSpace($text)) {
  Add-Type -AssemblyName System.Speech
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $speaker.Speak($text)
  } finally {
    $speaker.Dispose()
  }
}
`

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function buildSpeechCommand(platform: NodeJS.Platform = process.platform): SpeechCommand | null {
  if (platform === 'darwin') {
    return { command: '/usr/bin/say', args: [] }
  }

  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(WINDOWS_SPEAK_SCRIPT)
      ]
    }
  }

  return null
}

export class SpeechService {
  private active: ChildProcess | null = null
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: SpawnProcess

  constructor({
    platform = process.platform,
    spawnProcess = spawn
  }: {
    platform?: NodeJS.Platform
    spawnProcess?: SpawnProcess
  } = {}) {
    this.platform = platform
    this.spawnProcess = spawnProcess
  }

  speak(text: string): boolean {
    const value = text.trim()
    if (!value) return false

    const speechCommand = buildSpeechCommand(this.platform)
    if (!speechCommand) return false

    this.stop()
    const child = this.spawnProcess(speechCommand.command, speechCommand.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    })
    this.active = child

    const clearActive = () => {
      if (this.active === child) this.active = null
    }
    child.once('close', clearActive)
    child.once('exit', clearActive)
    child.once('error', clearActive)

    child.stdin?.write(value)
    child.stdin?.end()
    return true
  }

  stop(): void {
    if (!this.active || this.active.killed) return
    this.active.kill()
    this.active = null
  }

  dispose(): void {
    this.stop()
  }
}
