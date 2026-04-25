import type { FilterMode } from './types'

export function shouldProcessProgram(programName: string | undefined, mode: FilterMode, filterList: string[]): boolean {
  if (!programName || mode === 'default') return true
  const normalizedProgram = programName.toLowerCase()
  const normalizedList = filterList.map((item) => item.toLowerCase()).filter(Boolean)
  const found = normalizedList.some((item) => normalizedProgram.includes(item))
  if (mode === 'whitelist') return found
  if (mode === 'blacklist') return !found
  return true
}
