import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolvePortableUserDataDir } from './portableData'

describe('resolvePortableUserDataDir', () => {
  it('keeps Electron default when the portable launcher did not run', () => {
    expect(resolvePortableUserDataDir({})).toBeNull()
    expect(resolvePortableUserDataDir({ PORTABLE_EXECUTABLE_DIR: '' })).toBeNull()
    expect(resolvePortableUserDataDir({ PORTABLE_EXECUTABLE_DIR: '   ' })).toBeNull()
    expect(resolvePortableUserDataDir({ PORTABLE_EXECUTABLE_DIR: 42 as unknown as string })).toBeNull()
  })

  it('puts the profile in a data folder beside the portable exe', () => {
    const exeDir = 'D:\\Share\\FlashAgent'
    expect(resolvePortableUserDataDir({ PORTABLE_EXECUTABLE_DIR: exeDir })).toBe(resolve(exeDir, 'data'))
  })
})
