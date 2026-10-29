import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  agentToolDefinitionsForShell,
  assessCommandRisk,
  executeAgentTool,
  findLatestChecklistState,
  findGitBash,
  formatChecklistAnchor,
  isForbiddenCommand,
  isReadOnlyTool,
  isSensitivePath,
  parseTodoTasks,
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

  it('requires approval for sensitive reads and reads outside the working directory', () => {
    expect(requiresApproval('read_file', { path: 'src/main.ts' }, workDir)).toBe(false)
    expect(requiresApproval('read_file', { path: '.env' }, workDir)).toBe(true)
    expect(requiresApproval('list_dir', { path: '.' }, workDir)).toBe(false)
    const outside = resolve(tmpdir(), 'elsewhere')
    expect(requiresApproval('read_file', { path: join(outside, 'notes.txt') }, workDir)).toBe(true)
    expect(requiresApproval('list_dir', { path: outside }, workDir)).toBe(true)
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

  it('skips sensitive files instead of bypassing read_file approval', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(searchDir, { recursive: true })
    writeFileSync(join(searchDir, '.env'), 'secretNeedle=1\n', 'utf8')
    writeFileSync(join(searchDir, 'plain.ts'), 'secretNeedle=2\n', 'utf8')

    const output = await executeAgentTool('search_files', { path: searchDir, pattern: 'secretNeedle' }, workDir)

    expect(output).toContain('plain.ts')
    expect(output).not.toContain('secretNeedle=1')
    expect(output).toContain('sensitive file(s) skipped')
  })

  it('requires glob or pattern', async () => {
    await expect(executeAgentTool('search_files', {}, workDir)).rejects.toThrow(/glob.*pattern|pattern.*glob/)
  })

  it('rejects invalid regex patterns', async () => {
    await expect(executeAgentTool('search_files', { pattern: '([' }, workDir)).rejects.toThrow(/invalid regex/)
  })

  it('runs without approval when it stays inside the working directory', () => {
    expect(requiresApproval('search_files', { pattern: 'x' }, workDir)).toBe(false)
  })

  it('requires approval when the search root leaves the working directory', () => {
    const outside = resolve(tmpdir(), 'elsewhere')
    expect(requiresApproval('search_files', { path: outside, pattern: 'x' }, workDir)).toBe(true)
  })

  it('summarizes the search root with glob and pattern', () => {
    expect(summarizeToolCall('search_files', { glob: '*.ts', pattern: 'foo' })).toBe('*.ts · foo')
    expect(summarizeToolCall('search_files', { path: 'C:\\other', glob: '*.ts', pattern: 'foo' })).toBe(
      'C:\\other · *.ts · foo'
    )
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

describe('run_command shell invocation', () => {
  const isWin = process.platform === 'win32'
  const gitBash = isWin ? findGitBash() : null

  it.runIf(!!gitBash)('keeps a quoted & inside the approved bash command', async () => {
    // exec used to re-parse this line through cmd.exe, where the inner quote
    // flips cmd's quoting state and `&` starts a second OS command.
    const output = await executeAgentTool(
      'run_command',
      { command: 'echo "left & right"' },
      workDir,
      undefined,
      undefined,
      'gitbash'
    )
    expect(output.trim()).toBe('left & right')
  })

  it.runIf(isWin)('runs through Windows PowerShell when selected', async () => {
    const output = await executeAgentTool('run_command', { command: 'echo ps-ok' }, workDir, undefined, undefined, 'powershell')
    expect(output).toContain('ps-ok')
  })

  it.runIf(isWin)('hands cmd.exe its pre-quoted command line verbatim', async () => {
    const output = await executeAgentTool('run_command', { command: 'echo cmd-ok' }, workDir, undefined, undefined, 'cmd')
    expect(output).toContain('cmd-ok')
  })

  it.runIf(!!gitBash)('rejects and kills the tree when the command times out', async () => {
    await expect(
      executeAgentTool('run_command', { command: 'sleep 5', timeout_seconds: 1 }, workDir, undefined, undefined, 'gitbash')
    ).rejects.toThrow(/timed out/)
  })
})

describe('list_dir tree exploration with max_depth', () => {
  it('formats directory hierarchy with tree indentation when max_depth > 1', async () => {
    const { mkdirSync } = await import('node:fs')
    const treeRoot = join(workDir, 'tree-test')
    mkdirSync(join(treeRoot, 'subA', 'nested'), { recursive: true })
    mkdirSync(join(treeRoot, 'subB'), { recursive: true })
    writeFileSync(join(treeRoot, 'root.txt'), 'root', 'utf8')
    writeFileSync(join(treeRoot, 'subA', 'a.txt'), 'a', 'utf8')
    writeFileSync(join(treeRoot, 'subA', 'nested', 'deep.txt'), 'deep', 'utf8')

    const output = await executeAgentTool('list_dir', { path: treeRoot, max_depth: 3 }, workDir)
    expect(output).toContain('tree max_depth=3')
    expect(output).toContain('subA/')
    expect(output).toContain('  nested/')
    expect(output).toContain('    deep.txt')
    expect(output).toContain('  a.txt')
    expect(output).toContain('subB/')
    expect(output).toContain('root.txt')
  })
})

describe('search_files with context_lines', () => {
  it('includes preceding and trailing lines with line numbers', async () => {
    const contextDir = join(workDir, 'context-test')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(contextDir, { recursive: true })
    writeFileSync(
      join(contextDir, 'context.ts'),
      ['line 1', 'line 2', 'TARGET_MATCH', 'line 4', 'line 5'].join('\n'),
      'utf8'
    )

    const output = await executeAgentTool(
      'search_files',
      { path: contextDir, pattern: 'TARGET_MATCH', context_lines: 1 },
      workDir
    )
    expect(output).toContain('context.ts-2- line 2')
    expect(output).toContain('context.ts:3: TARGET_MATCH')
    expect(output).toContain('context.ts-4- line 4')
  })
})

describe('todo_list and checklist parsing', () => {
  it('parses valid task items and defaults missing values', () => {
    const raw = [
      { text: 'Task 1', status: 'completed' },
      { id: '2', text: 'Task 2', status: 'in_progress' },
      { id: 'custom', text: 'Task 3', status: 'invalid_status' },
      { text: '' } // should be filtered out
    ]
    const parsed = parseTodoTasks(raw)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({ id: '1', text: 'Task 1', status: 'completed' })
    expect(parsed[1]).toEqual({ id: '2', text: 'Task 2', status: 'in_progress' })
    expect(parsed[2]).toEqual({ id: 'custom', text: 'Task 3', status: 'pending' })
  })

  it('formats task checklist in todoListTool output', async () => {
    const tasks = [
      { id: '1', text: 'Step 1', status: 'completed' },
      { id: '2', text: 'Step 2', status: 'in_progress' },
      { id: '3', text: 'Step 3', status: 'pending' }
    ]
    const output = await executeAgentTool('todo_list', { tasks }, workDir)
    expect(output).toContain('1/3 completed, 1 in progress, 1 pending')
    expect(output).toContain('[x] 1. Step 1')
    expect(output).toContain('[>] 2. Step 2')
    expect(output).toContain('[ ] 3. Step 3')

    const summary = summarizeToolCall('todo_list', { tasks })
    expect(summary).toBe('Update checklist (1/3 done)')
  })

  it('extracts latest checklist state from conversation history', () => {
    const tasks = [
      { id: '1', text: 'Step 1', status: 'completed' },
      { id: '2', text: 'Step 2', status: 'in_progress' }
    ]
    const history = [
      { role: 'user' as const, text: 'start' },
      {
        role: 'assistant' as const,
        text: 'started',
        toolTrace: [
          {
            id: 'c1',
            name: 'todo_list',
            argsJson: JSON.stringify({ tasks }),
            result: 'ok'
          }
        ]
      },
      { role: 'user' as const, text: 'continue' }
    ]
    const anchor = findLatestChecklistState(history)
    expect(anchor).toContain('1/2 completed, 1 in progress')
    expect(anchor).toContain('[x] 1. Step 1')
    expect(anchor).toContain('[>] 2. Step 2')
  })
})

describe('isReadOnlyTool classification', () => {
  it('correctly identifies built-in read-only tools', () => {
    expect(isReadOnlyTool('read_file')).toBe(true)
    expect(isReadOnlyTool('list_dir')).toBe(true)
    expect(isReadOnlyTool('search_files')).toBe(true)
    expect(isReadOnlyTool('read_tool_output')).toBe(true)
    expect(isReadOnlyTool('todo_list')).toBe(true)
  })

  it('correctly identifies mutating built-in tools as not read-only', () => {
    expect(isReadOnlyTool('write_file')).toBe(false)
    expect(isReadOnlyTool('edit_file')).toBe(false)
    expect(isReadOnlyTool('run_command')).toBe(false)
  })

  it('identifies read-only MCP tools by prefix convention', () => {
    expect(isReadOnlyTool('mcp__server__read_data')).toBe(true)
    expect(isReadOnlyTool('mcp__server__get_user')).toBe(true)
    expect(isReadOnlyTool('mcp__server__list_repos')).toBe(true)
    expect(isReadOnlyTool('mcp__server__delete_record')).toBe(false)
    expect(isReadOnlyTool('mcp__server__execute_sql')).toBe(false)
  })
})
