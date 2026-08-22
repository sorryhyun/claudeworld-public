/**
 * Image compression for attachments: every image is re-encoded as WebP before it
 * reaches the database or the Claude API, both of which carry it as base64. The
 * load-bearing property is the failure mode — **every error returns the
 * originals unchanged**, costing the size reduction, never the message.
 */

import sharp from 'sharp'

import { getSettings } from '../config/settings'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('ImageUtils')

/** 0-6; 6 is the slowest and smallest. */
const WEBP_EFFORT = 6

export interface CompressedImage {
  /** The re-encoded payload, or the original on any failure. */
  readonly data: string
  readonly mediaType: string
}

/**
 * A no-op when `IMAGE_CONVERT_TO_WEBP` is false. Never throws — a bad payload,
 * an unsupported format or a truncated buffer come back as the originals.
 */
export async function compressImageBase64(
  base64Data: string,
  mediaType: string,
  webpQuality: number = getSettings().imageWebpQuality,
): Promise<CompressedImage> {
  if (!getSettings().imageConvertToWebp) {
    return { data: base64Data, mediaType }
  }

  try {
    // `Buffer.from(…, 'base64')` never throws; garbage is caught one line down
    // by sharp refusing the buffer.
    const imageBytes = Buffer.from(base64Data, 'base64')

    const compressedBytes = await sharp(imageBytes)
      .webp({ quality: webpQuality, effort: WEBP_EFFORT })
      .toBuffer()

    return { data: compressedBytes.toString('base64'), mediaType: 'image/webp' }
  } catch (error) {
    // The app must not break over an attachment.
    logger.warning(`Image compression failed: ${String(error)}`)
    return { data: base64Data, mediaType }
  }
}

/**
 * As above, with logging. `context` is a phrase for the log line ("world 5").
 * The sizes logged are **base64 string** lengths, which is what the payload cap
 * and the API request are measured in.
 */
export async function tryCompressImage(
  imageData: string | null | undefined,
  imageMediaType: string | null | undefined,
  context = '',
): Promise<{ data: string | null; mediaType: string | null }> {
  if (!imageData || !imageMediaType) {
    return { data: imageData ?? null, mediaType: imageMediaType ?? null }
  }

  try {
    const contextSuffix = context ? ` for ${context}` : ''
    logger.info(`Compressing image${contextSuffix}`)

    const compressed = await compressImageBase64(imageData, imageMediaType)

    const originalSize = imageData.length
    const compressedSize = compressed.data.length
    const ratio = originalSize > 0 ? (1 - compressedSize / originalSize) * 100 : 0
    logger.info(
      `Image compressed: ${originalSize} -> ${compressedSize} bytes (${ratio.toFixed(1)}% reduction)`,
    )

    return { data: compressed.data, mediaType: compressed.mediaType }
  } catch (error) {
    // `compressImageBase64` swallows its own failures; this means logging did not.
    logger.warning(`Image compression failed, using original: ${String(error)}`)
    return { data: imageData, mediaType: imageMediaType }
  }
}
