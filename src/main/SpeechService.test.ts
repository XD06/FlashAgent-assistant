import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SpeechService, buildSpeechCommand } from './SpeechService'

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    killed: boolean
  }
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  child.killed = false
  return child
}

describe('SpeechService', () => {
  it('uses macOS say and reads text from stdin', () => {
    expect(buildSpeechCommand('darwin')).toEqual({
      command: '/usr/bin/say',
      args: []
    })
  })

  it('uses Windows PowerShell TTS without putting spoken text in command args', () => {
    const command = buildSpeechCommand('win32')

    expect(command?.command).toMatch(/powershell/i)
    expect(command?.args).toContain('-EncodedCommand')
    expect(command?.args.join(' ')).not.toContain('selected text')
  })

  it('writes trimmed text to stdin and stops the previous speech before starting another', () => {
    const first = createChild()
    const second = createChild()
    const spawnProcess = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const service = new SpeechService({ platform: 'darwin', spawnProcess })

    expect(service.speak('  hello world  ')).toBe(true)
    expect(first.stdin.write).toHaveBeenCalledWith('hello world')
    expect(first.stdin.end).toHaveBeenCalled()

    expect(service.speak('next')).toBe(true)
    expect(first.kill).toHaveBeenCalled()
    expect(second.stdin.write).toHaveBeenCalledWith('next')
  })

  it('ignores empty text', () => {
    const spawnProcess = vi.fn()
    const service = new SpeechService({ platform: 'darwin', spawnProcess })

    expect(service.speak('  ')).toBe(false)
    expect(spawnProcess).not.toHaveBeenCalled()
  })
})
