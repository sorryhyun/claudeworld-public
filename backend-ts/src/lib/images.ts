/**
 * Image compression for attachments — port of `backend/utils/images.py`.
 *
 * Every image the user attaches is re-encoded as WebP before it is written to
 * the database and before it is handed to the Claude API, because the payload
 * is carried as base64 in both places and WebP is 25-35% smaller than PNG/JPEG
 * at the same visual quality while still carrying alpha.
 *
 * The load-bearing property is the failure mode: **every error returns the
 * originals unchanged.** An attachment that cannot be re-encoded is stored as
 * it arrived, which is a row the frozen Python backend also produces and reads.
 * What a failure costs is the size reduction, never the message.
 *
 * Pillow → sharp equivalences:
 *
 * | Pillow                    | sharp                     |
 * |---------------------------|---------------------------|
 * | `quality=<q>`             | `quality: <q>`            |
 * | `method=6` (best/slowest) | `effort: 6` (best/slowest)|
 * | `if mode == "P": RGBA`    | implicit — see below      |
 *
 * Pillow has to convert palette-mode (`P`) images to `RGBA` by hand because its
 * WebP encoder cannot read an indexed buffer. libvips decodes an indexed PNG to
 * RGBA (or RGB, absent a `tRNS` chunk) in the loader, so the conversion has
 * already happened by the time the encoder sees the pixels; transparency on an
 * indexed source survives. `src/tests/images.test.ts` pins that.
 */

import sharp from 'sharp'

import { getSettings } from '../config/settings'
import { getLogger } from '../infrastructure/logging/logger'

/** Python's logger name, kept so the two backends' logs interleave readably. */
const logger = getLogger('ImageUtils')

/**
 * WebP encoder effort, 0-6. Pillow calls this `method`; 6 is the slowest and
 * smallest setting in both libraries.
 */
const WEBP_EFFORT = 6

export interface CompressedImage {
  /** Base64 payload — the re-encoded one, or the original on any failure. */
  readonly data: string
  /** `'image/webp'` after a successful conversion, else the original type. */
  readonly mediaType: string
}

/**
 * Re-encode a base64 image as WebP.
 *
 * `webpQuality` defaults to `IMAGE_WEBP_QUALITY`, and the whole function is a
 * no-op when `IMAGE_CONVERT_TO_WEBP` is false. Never throws: a bad payload, an
 * unsupported format or a truncated buffer all come back as the originals with
 * a warning, exactly as `compress_image_base64` does.
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
    // `Buffer.from(…, 'base64')` never throws — it stops at the first byte it
    // cannot decode — so garbage input is caught one line down by sharp
    // refusing the buffer, not here. Python's `b64decode` raises on bad
    // padding instead; both paths end in the same `catch`.
    const imageBytes = Buffer.from(base64Data, 'base64')

    const compressedBytes = await sharp(imageBytes)
      .webp({ quality: webpQuality, effort: WEBP_EFFORT })
      .toBuffer()

    return { data: compressedBytes.toString('base64'), mediaType: 'image/webp' }
  } catch (error) {
    // If compression fails, log and return the original: the app must not break
    // over an attachment.
    logger.warning(`Image compression failed: ${String(error)}`)
    return { data: base64Data, mediaType }
  }
}

/**
 * Compress an image with logging, returning the originals on failure.
 *
 * `context` is a phrase for the log line ("world 5", "room 12"); an empty one
 * drops the ` for …` clause, as Python's does.
 *
 * The two sizes in the "Image compressed" line are the lengths of the **base64
 * strings**, not of the decoded bytes — that is the quantity the payload cap
 * and the API request are measured in, and it is what Python reports.
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
    // `compressImageBase64` swallows its own failures, so reaching this is a
    // surprise (a logger fault, an OOM). Python keeps the same belt-and-braces
    // wrapper and so does this.
    logger.warning(`Image compression failed, using original: ${String(error)}`)
    return { data: imageData, mediaType: imageMediaType }
  }
}
