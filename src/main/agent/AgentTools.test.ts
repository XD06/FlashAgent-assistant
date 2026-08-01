import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  agentToolDefinitionsForShell,
  assessCommandRisk,
  executeAgentTool,
  isForbiddenCommand,
  isSensitivePath,
  requiresApproval,
  resolveAgentPath,
  resolveCommandShell,
  shellSyntaxLabel,
  summarizeToolCall
} from './AgentTools'

const workDir = mkdtempSync(join(tmpdir(), 'agent-tools-test-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('resolveAgentPath', () => {
  it('resolves relative paths against the working directory', () => {
    expect(resolveAgentPath(workDir, 'a/b.txt')).toBe(resolve(workDir, 'a/b.txt'))
  })

  it('keeps absolute paths as-is (no sandbox by design)', () => {
    const abs = resolve(tmpdir(), 'elsewhere', 'x.txt')
    expect(resolveAgentPath(workDir, abs)).toBe(abs)
  })

  it('expands ~ to the home directory', () => {
    expect(resolveAgentPath(workDir, '~/notes.txt')).toBe(resolve(homedir(), 'notes.txt'))
    expect(resolveAgentPath(workDir, '~')).toBe(resolve(homedir()))
  })

  it('rejects empty paths', () => {
    expect(() => resolveAgentPath(workDir, '')).toThrow()
    expect(() => resolveAgentPath(workDir, '   ')).toThrow()
  })
})

describe('command shell selection', () => {
  const isWin = process.platform === 'win32'

  it('labels every shell kind with an explicit syntax contract', () => {
    expect(shellSyntaxLabel('gitbash')).toContain('bash syntax')
    expect(shellSyntaxLabel('pwsh')).toContain('PowerShell 7')
    expect(shellSyntaxLabel('pwsh')).toContain('PowerShell syntax')
    expect(shellSyntaxLabel('powershell')).toContain('Windows PowerShell 5')
    expect(shellSyntaxLabel('powershell')).toContain('PowerShell syntax')
    expect(shellSyntaxLabel('cmd')).toContain('CMD syntax')
    expect(shellSyntaxLabel('bash')).toBe('bash')
  })

  it('honors explicit powershell/cmd preferences on Windows, always bash elsewhere', () => {
    if (isWin) {
      expect(resolveCommandShell('powershell')).toBe('powershell')
      expect(resolveCommandShell('cmd')).toBe('cmd')
      // environment-dependent choices may only degrade toward PowerShell 5
      expect(['pwsh', 'powershell']).toContain(resolveCommandShell('pwsh'))
      expect(['gitbash', 'pwsh', 'powershell']).toContain(resolveCommandShell('auto'))
      expect(['gitbash', 'pwsh', 'powershell']).toContain(resolveCommandShell('gitbash'))
    } else {
      expect(resolveCommandShell('powershell')).toBe('bash')
      expect(resolveCommandShell('pwsh')).toBe('bash')
      expect(resolveCommandShell('cmd')).toBe('bash')
      expect(resolveCommandShell('auto')).toBe('bash')
    }
  })

  it('rewrites only the run_command description for the configured shell', () => {
    const defs = agentToolDefinitionsForShell(isWin ? 'cmd' : 'auto')
    const runCommand = defs.find((def) => def.name === 'run_command')
    expect(runCommand?.description).toContain(shellSyntaxLabel(resolveCommandShell(isWin ? 'cmd' : 'auto')))
    if (isWin) expect(runCommand?.description).toContain('CMD syntax')
    // every other definition passes through untouched (same reference)
    for (const def of defs) {
      if (def.name !== 'run_command') {
        expect(def.description).not.toContain('CMD syntax')
      }
    }
  })
})

describe('isForbiddenCommand', () => {
  it.each([
    'rm -rf /',
    'rm -rf ~',
    'rm -rf C:\\',
    'mkfs.ext4 /dev/sda1',
    'format c:',
    'shutdown /s /t 0',
    'reg add HKLM\\Software\\Foo /v Bar',
    'reg delete HKCU\\Software\\Foo',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:'
  ])('blocks catastrophic command: %s', (command) => {
    expect(isForbiddenCommand(command)).toBe(true)
  })

  it.each([
    'git status',
    'npm run build',
    'rm -rf node_modules',
    'rm dist/bundle.js',
    'ls -la',
    'echo hello > out.txt',
    'python format_check.py'
  ])('allows normal command: %s', (command) => {
    expect(isForbiddenCommand(command)).toBe(false)
  })
})

describe('assessCommandRisk', () => {
  it.each(['rm -rf /', 'format c:', 'shutdown /s /t 0', 'dd if=/dev/zero of=/dev/sda'])(
    'classifies catastrophic command as forbidden: %s',
    (command) => {
      expect(assessCommandRisk(command)).toBe('forbidden')
    }
  )

  it.each([
    'rm -rf node_modules',
    'del build\\output.txt',
    'Remove-Item dist -Recurse',
    'git reset --hard HEAD~1',
    'git push --force origin main',
    'taskkill /f /im node.exe',
    'Stop-Process -Name electron',
    'DROP TABLE users'
  ])('classifies destructive command as dangerous: %s', (command) => {
    expect(assessCommandRisk(command)).toBe('dangerous')
  })

  it.each([
    'git status',
    'npm run build',
    'ls -la',
    'echo hello > out.txt',
    'python format_check.py',
    'pnpm install',
    'git push origin main'
  ])('classifies ordinary command as safe: %s', (command) => {
    expect(assessCommandRisk(command)).toBe('safe')
  })
})

describe('isSensitivePath', () => {
  it.each([
    '.env',
    'project/.env.local',
    'C:\\Users\\me\\.ssh\\config',
    '/home/me/.ssh/id_rsa',
    'id_ed25519',
    'server.pem',
    'aws/credentials',
    '.npmrc'
  ])('flags secret-bearing path: %s', (path) => {
    expect(isSensitivePath(path)).toBe(true)
  })

  it.each(['src/index.ts', 'environment.ts', 'docs/keyboard.md', 'package.json'])(
    'ignores ordinary path: %s',
    (path) => {
      expect(isSensitivePath(path)).toBe(false)
    }
  )
})

describe('requiresApproval', () => {
  it('always requires approval for mutating tools', () => {
    expect(requiresApproval('write_file', { path: 'a.txt' }, workDir)).toBe(true)
    expect(requiresApproval('edit_file', { path: 'a.txt' }, workDir)).toBe(true)
    expect(requiresApproval('run_command', { command: 'ls' }, workDir)).toBe(true)
  })

  it('requires approval only for sensitive reads', () => {
    expect(requiresApproval('read_file', { path: 'src/main.ts' }, workDir)).toBe(false)
    expect(requiresApproval('read_file', { path: '.env' }, workDir)).toBe(true)
    expect(requiresApproval('list_dir', { path: '.' }, workDir)).toBe(false)
  })
})

describe('summarizeToolCall', () => {
  it('summarizes by command or path', () => {
    expect(summarizeToolCall('run_command', { command: 'git log' })).toBe('git log')
    expect(summarizeToolCall('edit_file', { path: 'src/a.ts', old_text: 'x' })).toBe('src/a.ts')
  })
})

describe('edit_file', () => {
  it('replaces a unique match exactly once', async () => {
    const file = join(workDir, 'edit-target.txt')
    writeFileSync(file, 'alpha\nbeta\ngamma\n', 'utf8')
    await executeAgentTool('edit_file', { path: file, old_text: 'beta', new_text: 'BETA' }, workDir)
    expect(readFileSync(file, 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('fails when old_text is missing from the file', async () => {
    const file = join(workDir, 'edit-missing.txt')
    writeFileSync(file, 'alpha\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: 'nope', new_text: 'x' }, workDir)
    ).rejects.toThrow(/not found/)
  })

  it('fails when old_text matches multiple locations', async () => {
    const file = join(workDir, 'edit-dup.txt')
    writeFileSync(file, 'dup\ndup\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: 'dup', new_text: 'x' }, workDir)
    ).rejects.toThrow(/multiple/)
  })

  it('replaces every occurrence when replace_all is true', async () => {
    const file = join(workDir, 'edit-all.txt')
    writeFileSync(file, 'dup one dup two dup\n', 'utf8')
    const result = await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'dup', new_text: 'X', replace_all: true },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('X one X two X\n')
    expect(result).toContain('3 occurrences')
  })

  it('replace_all still fails when old_text is missing', async () => {
    const file = join(workDir, 'edit-all-missing.txt')
    writeFileSync(file, 'alpha\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: 'nope', new_text: 'x', replace_all: true }, workDir)
    ).rejects.toThrow(/not found/)
  })

  it('rejects empty old_text', async () => {
    const file = join(workDir, 'edit-empty.txt')
    writeFileSync(file, 'alpha\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: '', new_text: 'x' }, workDir)
    ).rejects.toThrow(/empty/)
  })

  it('matches LF old_text against a CRLF file and keeps CRLF endings', async () => {
    const file = join(workDir, 'edit-crlf.txt')
    writeFileSync(file, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'alpha\nbeta', new_text: 'one\ntwo' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('one\r\ntwo\r\ngamma\r\n')
  })

  it('matches CRLF old_text against an LF file', async () => {
    const file = join(workDir, 'edit-lf.txt')
    writeFileSync(file, 'alpha\nbeta\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'alpha\r\nbeta', new_text: 'done' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('done\n')
  })

  it('escapes regex metacharacters in tolerant matching', async () => {
    const file = join(workDir, 'edit-meta.txt')
    writeFileSync(file, 'const re = /a.+b(c)?/\r\nnext\r\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'const re = /a.+b(c)?/\nnext', new_text: 'replaced' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('replaced\r\n')
  })

  it('replace_all works with line-ending tolerance', async () => {
    const file = join(workDir, 'edit-crlf-all.txt')
    writeFileSync(file, 'a\r\nx\r\na\r\nx\r\n', 'utf8')
    const result = await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'a\nx', new_text: 'b\ny', replace_all: true },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('b\r\ny\r\nb\r\ny\r\n')
    expect(result).toContain('2 occurrences')
  })

  it('matches when the file has trailing whitespace old_text lacks', async () => {
    const file = join(workDir, 'edit-trail-file.txt')
    writeFileSync(file, 'alpha  \nbeta\ngamma\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'alpha\nbeta', new_text: 'one\ntwo' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\ngamma\n')
  })

  it('matches when old_text has trailing whitespace the file lacks', async () => {
    const file = join(workDir, 'edit-trail-old.txt')
    writeFileSync(file, 'alpha\nbeta\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'alpha \nbeta', new_text: 'done' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('done\n')
  })

  it('combines trailing-whitespace tolerance with CRLF preservation', async () => {
    const file = join(workDir, 'edit-trail-crlf.txt')
    writeFileSync(file, 'alpha  \r\nbeta\r\ngamma\r\n', 'utf8')
    await executeAgentTool(
      'edit_file',
      { path: file, old_text: 'alpha\nbeta', new_text: 'one\ntwo' },
      workDir
    )
    expect(readFileSync(file, 'utf8')).toBe('one\r\ntwo\r\ngamma\r\n')
  })

  it('does not relax leading indentation', async () => {
    const file = join(workDir, 'edit-indent.txt')
    writeFileSync(file, 'indented\nnext\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: '  indented\nnext', new_text: 'x' }, workDir)
    ).rejects.toThrow(/not found/)
  })

  it('points at the first-line location when the rest of old_text diverges', async () => {
    const file = join(workDir, 'edit-diverge.txt')
    writeFileSync(file, 'alpha\nbeta-line\ngamma\n', 'utf8')
    await expect(
      executeAgentTool(
        'edit_file',
        { path: file, old_text: 'beta-line\nWRONG', new_text: 'x' },
        workDir
      )
    ).rejects.toThrow(/line 2.*re-read lines 2-3/s)
  })

  it('reports line endings and file size when old_text is nowhere near', async () => {
    const file = join(workDir, 'edit-nowhere.txt')
    writeFileSync(file, 'alpha\r\nbeta\r\n', 'utf8')
    await expect(
      executeAgentTool('edit_file', { path: file, old_text: 'missing-entirely', new_text: 'x' }, workDir)
    ).rejects.toThrow(/CRLF line endings/)
  })
})

describe('write_file / read_file / list_dir', () => {
  it('writes a new file, creating parent directories', async () => {
    const result = await executeAgentTool(
      'write_file',
      { path: 'nested/dir/new.txt', content: 'hello' },
      workDir
    )
    expect(result).toContain('Created')
    expect(readFileSync(join(workDir, 'nested/dir/new.txt'), 'utf8')).toBe('hello')
  })

  it('reads back a slice with line numbers', async () => {
    const file = join(workDir, 'read-me.txt')
    writeFileSync(file, 'one\ntwo\nthree\n', 'utf8')
    const output = await executeAgentTool('read_file', { path: file, offset: 2, limit: 1 }, workDir)
    expect(output).toContain('2→two')
    expect(output).not.toContain('1→one')
  })

  it('tags the file line-ending style in the read_file header', async () => {
    const crlfFile = join(workDir, 'read-crlf.txt')
    writeFileSync(crlfFile, 'one\r\ntwo\r\n', 'utf8')
    expect(await executeAgentTool('read_file', { path: crlfFile }, workDir)).toContain(', CRLF):')

    const lfFile = join(workDir, 'read-lf.txt')
    writeFileSync(lfFile, 'one\ntwo\n', 'utf8')
    expect(await executeAgentTool('read_file', { path: lfFile }, workDir)).toContain(', LF):')
  })

  it('lists directory entries with a slash suffix for dirs', async () => {
    const output = await executeAgentTool('list_dir', { path: 'nested' }, workDir)
    expect(output).toContain('dir/')
  })

  it('refuses forbidden commands before execution', async () => {
    await expect(
      executeAgentTool('run_command', { command: 'shutdown /s' }, workDir)
    ).rejects.toThrow(/blacklist/)
  })

  it('throws on unknown tool names', async () => {
    await expect(executeAgentTool('nope_tool', {}, workDir)).rejects.toThrow(/Unknown/)
  })
})

describe('search_files', () => {
  const searchDir = join(workDir, 'search-root')

  it('finds lines matching a regex, with path:line: snippet format', async () => {
    writeFileSync(join(workDir, 'search-a.ts'), 'const alphaToken = 1\nconst other = 2\n', 'utf8')
    const output = await executeAgentTool('search_files', { pattern: 'alphaToken' }, workDir)
    expect(output).toContain('search-a.ts:1:')
    expect(output).toContain('alphaToken')
    expect(output).not.toContain('const other')
  })

  it('filters files by glob and combines with content pattern', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(searchDir, { recursive: true })
    writeFileSync(join(searchDir, 'match.md'), 'needle here\n', 'utf8')
    writeFileSync(join(searchDir, 'match.txt'), 'needle here\n', 'utf8')
    const output = await executeAgentTool('search_files', { path: searchDir, glob: '*.md', pattern: 'needle' }, workDir)
    expect(output).toContain('match.md:1:')
    expect(output).not.toContain('match.txt')
  })

  it('returns file paths when only a glob is given', async () => {
    const output = await executeAgentTool('search_files', { glob: 'search-a.ts' }, workDir)
    expect(output).toContain('search-a.ts')
  })

  it('supports nested ** filename globs', async () => {
    const { mkdirSync } = await import('node:fs')
    const nested = join(searchDir, 'nested', 'fetch')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'Headers.test.ts'), 'describe("Headers", () => {})\n', 'utf8')

    const output = await executeAgentTool('search_files', { path: searchDir, glob: '**/*Headers*.test.ts' }, workDir)

    expect(output).toContain('Headers.test.ts')
  })

  it('skips node_modules and dot directories', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(workDir, 'node_modules'), { recursive: true })
    writeFileSync(join(workDir, 'node_modules', 'dep.ts'), 'hiddenNeedle\n', 'utf8')
    const output = await executeAgentTool('search_files', { pattern: 'hiddenNeedle' }, workDir)
    expect(output).toContain('No matches')
  })

  it('requires glob or pattern', async () => {
    await expect(executeAgentTool('search_files', {}, workDir)).rejects.toThrow(/glob.*pattern|pattern.*glob/)
  })

  it('rejects invalid regex patterns', async () => {
    await expect(executeAgentTool('search_files', { pattern: '([' }, workDir)).rejects.toThrow(/invalid regex/)
  })

  it('runs without approval (read-only tool)', () => {
    expect(requiresApproval('search_files', { pattern: 'x' }, workDir)).toBe(false)
  })

  it('summarizes glob and pattern', () => {
    expect(summarizeToolCall('search_files', { glob: '*.ts', pattern: 'foo' })).toBe('*.ts · foo')
  })
})

describe('run_command live output', () => {
  it('streams chunks through onOutput while resolving the full result', async () => {
    const chunks: string[] = []
    const output = await executeAgentTool(
      'run_command',
      { command: 'echo streamed-line' },
      workDir,
      undefined,
      (chunk) => chunks.push(chunk)
    )
    expect(output).toContain('streamed-line')
    expect(chunks.join('')).toContain('streamed-line')
  })
})
