import type { NativeImage } from 'electron'

// Vision models downsample large images anyway; sending a full 4K PNG costs
// tens of MB of base64, multiple IPC copies and a much larger request body.
// 1600px keeps UI text legible while cutting the payload by an order of
// magnitude. Screenshots are opaque (the overlay paints a captured frame), so
// JPEG is safe and much smaller than PNG.
export const VISION_MAX_EDGE = 1600
export const VISION_JPEG_QUALITY = 85

export function visionSize(
  width: number,
  height: number
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const longest = Math.max(safeWidth, safeHeight)
  if (longest <= VISION_MAX_EDGE) return { width: safeWidth, height: safeHeight }
  const scale = VISION_MAX_EDGE / longest
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  }
}

/** Encode a screenshot/annotation image for the vision request only. */
export function encodeVisionImage(image: NativeImage): string {
  if (image.isEmpty()) throw new Error('Cannot encode an empty image for vision.')
  const { width, height } = image.getSize()
  const target = visionSize(width, height)
  const resized =
    target.width === width && target.height === height
      ? image
      : image.resize({ width: target.width, height: target.height, quality: 'good' })
  return `data:image/jpeg;base64,${resized.toJPEG(VISION_JPEG_QUALITY).toString('base64')}`
}
