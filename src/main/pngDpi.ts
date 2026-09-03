const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// CRC-32 (ISO 3309) as required by the PNG chunk spec.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Chunk {
  type: string
  data: Buffer
}

function parseChunks(png: Buffer): Chunk[] | null {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const chunks: Chunk[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    if (dataStart + length + 4 > png.length) return null
    chunks.push({ type, data: png.subarray(dataStart, dataStart + length) })
    offset = dataStart + length + 4
    if (type === 'IEND') break
  }
  return chunks
}

function serializeChunks(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [PNG_SIGNATURE]
  for (const chunk of chunks) {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(chunk.data.length, 0)
    header.write(chunk.type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data])), 0)
    parts.push(header, chunk.data, crc)
  }
  return Buffer.concat(parts)
}

/**
 * Tag a PNG with its capture DPI (pHYs chunk) so downstream viewers show it
 * at the original logical size instead of assuming 96 DPI and upscaling —
 * on a 150% display an untagged 1.5× screenshot renders 1.5× larger and
 * every viewer resample makes the text look soft.
 */
export function applyPngDpi(png: Buffer, dpi: number): Buffer {
  const chunks = parseChunks(png)
  if (!chunks || !chunks.some((chunk) => chunk.type === 'IHDR')) return png
  const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254))
  const data = Buffer.alloc(9)
  data.writeUInt32BE(pixelsPerMeter, 0)
  data.writeUInt32BE(pixelsPerMeter, 4)
  data.writeUInt8(1, 8) // unit: meter
  const filtered = chunks.filter((chunk) => chunk.type !== 'pHYs')
  const ihdrIndex = filtered.findIndex((chunk) => chunk.type === 'IHDR')
  filtered.splice(ihdrIndex + 1, 0, { type: 'pHYs', data })
  return serializeChunks(filtered)
}
