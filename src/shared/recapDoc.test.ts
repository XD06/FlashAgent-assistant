import { describe, expect, it } from 'vitest'
import {
  LEDGER_MAX_LINES,
  LEDGER_ROLL_MARK,
  RECAP_DOC_MAX_CHARS,
  mergeRecapDoc,
  parseRecapDoc,
  stripDocJunk,
  validateRecapDoc
} from './recapDoc'

/** Build a well-formed v2 doc from section bodies. */
function doc(s1: string, s2: string, s3: string, s4: string, s5: string): string {
  return [
    '# 复工文档',
    '## 1. 原始任务',
    s1,
    '## 2. 事实台账',
    s2,
    '## 3. 涉及文件与当前状态',
    s3,
    '## 4. 失败路径台账',
    s4,
    '## 5. 当前任务与下一步',
    s5
  ].join('\n')
}

describe('stripDocJunk', () => {
  it('cuts leading chatter before the title', () => {
    const raw = `好的，以下是压缩结果：\n\n${doc('任务A', '- 事实1', '无', '无', '- 下一步')}`
    expect(stripDocJunk(raw)?.startsWith('# 复工文档')).toBe(true)
  })

  it('drops a trailing markdown fence', () => {
    const raw = `${doc('任务A', '无', '无', '无', '无')}\n\`\`\``
    expect(stripDocJunk(raw)?.endsWith('```')).toBe(false)
  })

  it('returns null when the title is missing entirely', () => {
    expect(stripDocJunk('我无法完成这个任务。')).toBeNull()
  })
})

describe('validateRecapDoc', () => {
  it('accepts a well-formed doc', () => {
    expect(validateRecapDoc(doc('a', 'b', 'c', 'd', 'e'))).toBeNull()
  })

  it('reports missing section headers', () => {
    const broken = doc('a', 'b', 'c', 'd', 'e').replace('## 4. 失败路径台账\n', '')
    expect(validateRecapDoc(broken)).toContain('## 4. 失败路径台账')
  })

  it('rejects a legacy v1 summary (different section names)', () => {
    const v1 = ['# 复工文档', '## 1. 原始任务', 'a', '## 2. 关键结论与事实', 'b'].join('\n')
    expect(validateRecapDoc(v1)).not.toBeNull()
  })
})

describe('parseRecapDoc', () => {
  it('splits the five section bodies', () => {
    const parsed = parseRecapDoc(doc('任务', '- f1\n- f2', '`a.ts` — 已改', '无', '- 继续'))
    expect(parsed?.sections).toEqual(['任务', '- f1\n- f2', '`a.ts` — 已改', '无', '- 继续'])
  })

  it('returns null for unstructured text', () => {
    expect(parseRecapDoc('随便一段话')).toBeNull()
  })
})

describe('mergeRecapDoc', () => {
  it('appends new ledger entries below previous ones and rewrites 1/3/5', () => {
    const prev = doc('旧任务描述', '- 事实A', '`old.ts` — 已改', '- 坑A', '- 旧下一步')
    const next = doc('新任务描述', '- 事实B', '`new.ts` — 待改', '- 坑B', '- 新下一步')
    const merged = parseRecapDoc(mergeRecapDoc(prev, next))!
    expect(merged.sections[0]).toBe('新任务描述')
    expect(merged.sections[1]).toBe('- 事实A\n- 事实B')
    expect(merged.sections[2]).toBe('`new.ts` — 待改')
    expect(merged.sections[3]).toBe('- 坑A\n- 坑B')
    expect(merged.sections[4]).toBe('- 新下一步')
  })

  it('dedupes verbatim-identical ledger entries', () => {
    const prev = doc('t', '- 事实A\n- 事实B', '无', '无', '无')
    const next = doc('t', '- 事实B\n- 事实C', '无', '无', '无')
    const merged = parseRecapDoc(mergeRecapDoc(prev, next))!
    expect(merged.sections[1]).toBe('- 事实A\n- 事实B\n- 事实C')
  })

  it('ignores 无 placeholders in ledgers', () => {
    const prev = doc('t', '无', '无', '无', '无')
    const next = doc('t', '- 事实A', '无', '- 无', '无')
    const merged = parseRecapDoc(mergeRecapDoc(prev, next))!
    expect(merged.sections[1]).toBe('- 事实A')
    expect(merged.sections[3]).toBe('无')
  })

  it(`rolls the oldest entries past ${LEDGER_MAX_LINES} lines and marks the roll`, () => {
    const prevEntries = Array.from({ length: LEDGER_MAX_LINES }, (_, i) => `- 事实${i}`)
    const prev = doc('t', prevEntries.join('\n'), '无', '无', '无')
    const next = doc('t', '- 新事实X\n- 新事实Y', '无', '无', '无')
    const merged = parseRecapDoc(mergeRecapDoc(prev, next))!
    const lines = merged.sections[1].split('\n')
    expect(lines[0]).toBe(LEDGER_ROLL_MARK)
    expect(lines.length).toBe(LEDGER_MAX_LINES + 1) // mark + capped entries
    expect(lines).not.toContain('- 事实0')
    expect(lines).not.toContain('- 事实1')
    expect(lines[lines.length - 1]).toBe('- 新事实Y')
  })

  it('keeps the roll mark on later merges even without new overflow', () => {
    const prev = doc('t', `${LEDGER_ROLL_MARK}\n- 事实A`, '无', '无', '无')
    const next = doc('t', '- 事实B', '无', '无', '无')
    const merged = parseRecapDoc(mergeRecapDoc(prev, next))!
    expect(merged.sections[1].split('\n')[0]).toBe(LEDGER_ROLL_MARK)
  })

  it('falls back to next when prev is a legacy v1 summary', () => {
    const legacy = ['# 复工文档', '## 1. 原始任务', '旧', '## 2. 关键结论与事实', '- 旧事实'].join('\n')
    const next = doc('新', '- 新事实', '无', '无', '无')
    const merged = parseRecapDoc(mergeRecapDoc(legacy, next))!
    expect(merged.sections[0]).toBe('新')
    expect(merged.sections[1]).toBe('- 新事实')
  })

  it('falls back to next when prev is null', () => {
    const next = doc('新', '- 新事实', '无', '无', '无')
    expect(parseRecapDoc(mergeRecapDoc(null, next))!.sections[0]).toBe('新')
  })

  it('sheds oldest ledger entries first when the doc exceeds the size cap', () => {
    const bigEntry = (i: number): string => `- 事实${i}：${'x'.repeat(400)}`
    const prev = doc('t', Array.from({ length: 50 }, (_, i) => bigEntry(i)).join('\n'), '重要状态', '无', '- 下一步')
    const next = doc('t', bigEntry(50), '重要状态', '无', '- 下一步')
    const out = mergeRecapDoc(prev, next)
    expect(out.length).toBeLessThanOrEqual(RECAP_DOC_MAX_CHARS)
    const merged = parseRecapDoc(out)!
    // Rewrite sections survive intact; the facts ledger absorbed the cut.
    expect(merged.sections[2]).toBe('重要状态')
    expect(merged.sections[4]).toBe('- 下一步')
    expect(merged.sections[1]).toContain('- 事实50')
    expect(merged.sections[1]).toContain(LEDGER_ROLL_MARK)
  })

  it('truncates section 1 as the last resort', () => {
    const prev = doc(`${'长'.repeat(RECAP_DOC_MAX_CHARS)}`, '无', '状态', '无', '- 下一步')
    const next = doc(`${'长'.repeat(RECAP_DOC_MAX_CHARS)}`, '无', '状态', '无', '- 下一步')
    const out = mergeRecapDoc(prev, next)
    expect(out.length).toBeLessThanOrEqual(RECAP_DOC_MAX_CHARS)
    const merged = parseRecapDoc(out)!
    expect(merged.sections[2]).toBe('状态')
    expect(merged.sections[4]).toBe('- 下一步')
  })
})
