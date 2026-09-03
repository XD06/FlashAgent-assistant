import { describe, expect, it } from 'vitest'
import { applyPngDpi } from './pngDpi'

// 1×1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

interface Chunk {
  type: string
  data: Buffer
}

function parseChunks(png: Buffer): Chunk[] {
  const chunks: Chunk[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

describe('applyPngDpi', () => {
  it('inserts a pHYs chunk after IHDR with the requested DPI', () => {
    const tagged = applyPngDpi(TINY_PNG, 144)
    const chunks = parseChunks(tagged)
    const types = chunks.map((chunk) => chunk.type)
    expect(types.indexOf('pHYs')).toBe(types.indexOf('IHDR') + 1)
    const phys = chunks.find((chunk) => chunk.type === 'pHYs')!
    expect(phys.data.length).toBe(9)
    // 144 DPI = 144/0.0254 ≈ 5669 pixels per meter
    expect(phys.data.readUInt32BE(0)).toBe(5669)
    expect(phys.data.readUInt32BE(4)).toBe(5669)
    expect(phys.data.readUInt8(8)).toBe(1)
  })

  it('keeps the PNG valid (signature, IHDR first, IEND last, intact data)', () => {
    const tagged = applyPngDpi(TINY_PNG, 96)
    const original = parseChunks(TINY_PNG)
    const chunks = parseChunks(tagged)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'pHYs',
      ...original.slice(1).map((chunk) => chunk.type)
    ])
    expect(chunks.find((chunk) => chunk.type === 'IDAT')!.data).toEqual(
      original.find((chunk) => chunk.type === 'IDAT')!.data
    )
  })

  it('replaces an existing pHYs chunk instead of duplicating it', () => {
    const once = applyPngDpi(TINY_PNG, 96)
    const twice = applyPngDpi(once, 144)
    const chunks = parseChunks(twice)
    expect(chunks.filter((chunk) => chunk.type === 'pHYs')).toHaveLength(1)
    expect(chunks.find((chunk) => chunk.type === 'pHYs')!.data.readUInt32BE(0)).toBe(5669)
  })

  it('passes through non-PNG buffers untouched', () => {
    const notPng = Buffer.from('definitely not a png')
    expect(applyPngDpi(notPng, 144).equals(notPng)).toBe(true)
  })
})
