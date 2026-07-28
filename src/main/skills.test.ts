import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildSkillsPrompt, parseSkillFrontmatter, scanSkills } from './skills'

const dir = mkdtempSync(join(tmpdir(), 'skills-test-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseSkillFrontmatter', () => {
  it('extracts name and description', () => {
    const meta = parseSkillFrontmatter('---\nname: PDF Helper\ndescription: "Work with PDF files"\n---\n# Body')
    expect(meta).toEqual({ name: 'PDF Helper', description: 'Work with PDF files' })
  })

  it('returns empty for content without frontmatter', () => {
    expect(parseSkillFrontmatter('# Just markdown')).toEqual({})
  })

  it('stops at the closing delimiter', () => {
    const meta = parseSkillFrontmatter('---\nname: A\n---\ndescription: not-meta')
    expect(meta).toEqual({ name: 'A' })
  })
})

describe('scanSkills', () => {
  it('scans skill directories and applies the disabled list', async () => {
    const skillsDir = join(dir, 'skills')
    mkdirSync(join(skillsDir, 'alpha'), { recursive: true })
    mkdirSync(join(skillsDir, 'beta'), { recursive: true })
    mkdirSync(join(skillsDir, 'no-skill-md'), { recursive: true })
    writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: First skill\n---\n', 'utf8')
    writeFileSync(join(skillsDir, 'beta', 'SKILL.md'), '# no frontmatter', 'utf8')
    const skills = await scanSkills(skillsDir, ['beta'])
    expect(skills.map((s) => s.id)).toEqual(['alpha', 'beta'])
    expect(skills[0]).toMatchObject({ name: 'Alpha', description: 'First skill', enabled: true })
    // Falls back to the directory name when frontmatter is missing.
    expect(skills[1]).toMatchObject({ name: 'beta', enabled: false })
  })

  it('returns empty for a missing directory', async () => {
    expect(await scanSkills(join(dir, 'nope'), [])).toEqual([])
  })

  it('includes linked external folders and skips stale links', async () => {
    const linked = join(dir, 'external', 'my-skill')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, 'SKILL.md'), '---\nname: Linked\ndescription: Reused in place\n---\n', 'utf8')
    const skills = await scanSkills(join(dir, 'nope'), [], [linked, join(dir, 'gone')])
    expect(skills).toHaveLength(1)
    // Linked skills use the absolute path as id so disable toggles still work.
    expect(skills[0]).toMatchObject({ id: linked, name: 'Linked', linked: true, enabled: true, file: join(linked, 'SKILL.md') })
    const disabled = await scanSkills(join(dir, 'nope'), [linked], [linked])
    expect(disabled[0].enabled).toBe(false)
  })
})

describe('buildSkillsPrompt', () => {
  it('lists only enabled skills with their instruction paths', () => {
    const prompt = buildSkillsPrompt([
      { id: 'a', name: 'Alpha', description: 'First', file: '/skills/a/SKILL.md', enabled: true },
      { id: 'b', name: 'Beta', description: 'Second', file: '/skills/b/SKILL.md', enabled: false }
    ])
    expect(prompt).toContain('## Skills')
    expect(prompt).toContain('Alpha: First [instructions: /skills/a/SKILL.md]')
    expect(prompt).not.toContain('Beta')
  })

  it('returns empty when no skills are enabled', () => {
    expect(buildSkillsPrompt([])).toBe('')
  })
})
