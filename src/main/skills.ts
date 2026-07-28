import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { SkillInfo } from '@shared/types'

// Skills follow the community convention: one directory per skill with a
// SKILL.md whose YAML frontmatter carries `name` and `description`. Loading is
// progressive — only the metadata list goes into the system prompt; the agent
// reads the full SKILL.md (and any referenced files) with its own tools when a
// task actually matches.

export function getSkillsDir(userDataDir: string): string {
  return join(userDataDir, 'skills')
}

/** Extract `name` / `description` from a SKILL.md frontmatter block. Minimal
 * line-based parsing on purpose — no YAML dependency. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const result: { name?: string; description?: string } = {}
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '---') break
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (value) result[match[1] as 'name' | 'description'] = value
  }
  return result
}

/** Read and parse <dir>/SKILL.md. Returns null when missing/unreadable —
 * the caller decides whether that means "skip" or "invalid folder". */
export async function readSkillMeta(dir: string): Promise<{ name?: string; description?: string } | null> {
  try {
    return parseSkillFrontmatter(await fs.readFile(join(dir, 'SKILL.md'), 'utf8'))
  } catch {
    return null
  }
}

/** Scan the skills directory plus any linked external folders. Directories
 * without a readable SKILL.md are ignored; a missing skills directory simply
 * yields no skills. Linked skills use their absolute path as id so the
 * enable/disable switch works the same way. */
export async function scanSkills(
  skillsDir: string,
  disabledSkills: string[],
  linkedDirs: string[] = []
): Promise<SkillInfo[]> {
  let entries: string[] = []
  try {
    const dirents = await fs.readdir(skillsDir, { withFileTypes: true })
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    /* missing skills dir — linked skills may still exist */
  }
  const skills: SkillInfo[] = []
  for (const dirName of entries.sort()) {
    const dir = join(skillsDir, dirName)
    const meta = await readSkillMeta(dir)
    if (!meta) continue
    skills.push({
      id: dirName,
      name: meta.name ?? dirName,
      description: meta.description ?? '',
      file: join(dir, 'SKILL.md'),
      enabled: !disabledSkills.includes(dirName)
    })
  }
  // Linked folders are reused in place — never copied into the skills dir.
  // Stale links (folder or SKILL.md gone) are skipped silently; the settings
  // entry stays so the link revives if the folder comes back.
  for (const dir of linkedDirs) {
    const meta = await readSkillMeta(dir)
    if (!meta) continue
    skills.push({
      id: dir,
      name: meta.name ?? basename(dir),
      description: meta.description ?? '',
      file: join(dir, 'SKILL.md'),
      enabled: !disabledSkills.includes(dir),
      linked: true
    })
  }
  return skills
}

/** System-prompt section listing enabled skills. Empty when none. */
export function buildSkillsPrompt(skills: SkillInfo[]): string {
  const enabled = skills.filter((skill) => skill.enabled)
  if (!enabled.length) return ''
  const lines = enabled.map((skill) => `- ${skill.name}: ${skill.description || '(no description)'} [instructions: ${skill.file}]`)
  return `\n\n## Skills\nSpecialized skill instructions are available. When the user's task matches a skill's description, first use read_file on its instructions file, then follow those instructions. Do not read skill files that are irrelevant to the task.\n${lines.join('\n')}`
}
