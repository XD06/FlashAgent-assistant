import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { VISION_JPEG_QUALITY, encodeVisionImage, visionSize } from './visionImage'

function makeImage(width: number, height: number, empty = false) {
  const resized = {
    getSize: () => ({ width, height }),
    toJPEG: vi.fn(() => Buffer.from('resized-jpeg'))
  }
  const image = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => Buffer.from('original-jpeg'))
  }
  return {
    image: image as unknown as NativeImage,
    resize: image.resize,
    toJPEG: image.toJPEG,
    resized
  }
}

describe('visionSize', () => {
  it('keeps small images at their original size', () => {
    expect(visionSize(800, 600)).toEqual({ width: 800, height: 600 })
    expect(visionSize(1600, 900)).toEqual({ width: 1600, height: 900 })
  })

  it('scales the longest edge to 1600 without changing the aspect ratio', () => {
    expect(visionSize(3840, 2160)).toEqual({ width: 1600, height: 900 })
    expect(visionSize(1000, 2000)).toEqual({ width: 800, height: 1600 })
  })

  it('never rounds a very thin image down to zero', () => {
    expect(visionSize(1, 10000)).toEqual({ width: 1, height: 1600 })
    expect(visionSize(10000, 1)).toEqual({ width: 1600, height: 1 })
  })
})

describe('encodeVisionImage', () => {
  it('resizes a 4K screenshot and encodes JPEG at the configured quality', () => {
    const { image, resize, toJPEG, resized } = makeImage(3840, 2160)
    const dataUrl = encodeVisionImage(image)
    expect(resize).toHaveBeenCalledWith({ width: 1600, height: 900, quality: 'good' })
    expect(resized.toJPEG).toHaveBeenCalledWith(VISION_JPEG_QUALITY)
    expect(toJPEG).not.toHaveBeenCalled()
    expect(dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('resized-jpeg').toString('base64')}`)
  })

  it('does not upscale an image already under the limit', () => {
    const { image, resize, toJPEG } = makeImage(800, 600)
    const dataUrl = encodeVisionImage(image)
    expect(resize).not.toHaveBeenCalled()
    expect(toJPEG).toHaveBeenCalledWith(VISION_JPEG_QUALITY)
    expect(dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('original-jpeg').toString('base64')}`)
  })

  it('refuses an empty image', () => {
    const { image } = makeImage(0, 0, true)
    expect(() => encodeVisionImage(image)).toThrow(/empty image/)
  })
})
