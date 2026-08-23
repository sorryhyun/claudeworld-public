/**
 * `lib/images.ts` — the WebP re-encoder, against real image bytes.
 *
 * The images are generated here rather than checked in: a fixture PNG would be
 * a binary blob nobody can review, whereas pixels written out through
 * `png-codec.ts` are as real as any file on disk and describe themselves.
 *
 * What is being pinned is Python's contract in `backend/utils/images.py`, and
 * above all its failure mode — anything that cannot be re-encoded comes back
 * *unchanged*, never as an exception and never as a null.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { resetSettings } from '@/config/settings'
import { compressImageBase64, tryCompressImage } from '@/lib/images'
import { decodePngToRgba, encodeRgbaPng, encodeRgbPng, readPngLayout } from './png-codec'

// =============================================================================
// Fixtures
// =============================================================================

/**
 * A 128×128 RGB gradient, PNG-encoded.
 *
 * Photographic-ish rather than a flat fill: a solid colour is already a few
 * hundred bytes of PNG and lossy WebP can only lose to it, which would make the
 * "smaller payload" assertion a coin flip rather than a fact about the codec.
 */
function gradientPng(): string {
  const width = 128
  const height = 128
  const raw = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      raw[i] = (x * 2) % 256
      raw[i + 1] = (y * 2) % 256
      raw[i + 2] = (x * y) % 256
    }
  }
  return Buffer.from(encodeRgbPng(raw, width, height)).toString('base64')
}

/**
 * A 32×32 *indexed* PNG whose top-left 8×8 corner is fully transparent.
 *
 * `palette: true` writes a `PLTE` chunk plus a `tRNS` chunk — Pillow's `P` mode
 * with transparency, the one case `compress_image_base64` special-cases by
 * converting to `RGBA` before handing it to the encoder. The RGBA source is
 * written here and quantised by `Bun.Image`, the one encoder in the tree that
 * emits an indexed PNG. The palette is sized above the five distinct RGBA
 * values below — quantising to exactly four blends the transparent entry into
 * a partly-opaque one, which would test the quantiser rather than the encoder.
 */
async function indexedTransparentPng(): Promise<string> {
  const size = 32
  const raw = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      raw[i] = x < 16 ? 255 : 0
      raw[i + 1] = 0
      raw[i + 2] = y < 16 ? 255 : 0
      raw[i + 3] = x < 8 && y < 8 ? 0 : 255
    }
  }
  const indexed = await new Bun.Image(encodeRgbaPng(raw, size, size))
    .png({ palette: true, colors: 8 })
    .bytes()
  return Buffer.from(indexed).toString('base64')
}

/** Decoded pixels of a base64 payload, whatever container it arrived in. */
async function decode(base64: string): Promise<ReturnType<typeof decodePngToRgba>> {
  const png = await new Bun.Image(Buffer.from(base64, 'base64')).png().bytes()
  return decodePngToRgba(png)
}

/** Alpha of one pixel of a decoded image, by (x, y). */
async function alphaAt(base64: string, x: number, y: number): Promise<number> {
  const { width, rgba } = await decode(base64)
  return rgba[(y * width + x) * 4 + 3]!
}

// =============================================================================

describe('compressImageBase64', () => {
  // `.env` may carry either image setting; pin both so the suite describes the
  // defaults rather than the developer's machine.
  const savedConvert = process.env.IMAGE_CONVERT_TO_WEBP
  const savedQuality = process.env.IMAGE_WEBP_QUALITY

  beforeAll(() => {
    process.env.IMAGE_CONVERT_TO_WEBP = 'true'
    process.env.IMAGE_WEBP_QUALITY = '85'
    resetSettings()
  })

  afterAll(() => {
    if (savedConvert === undefined) delete process.env.IMAGE_CONVERT_TO_WEBP
    else process.env.IMAGE_CONVERT_TO_WEBP = savedConvert
    if (savedQuality === undefined) delete process.env.IMAGE_WEBP_QUALITY
    else process.env.IMAGE_WEBP_QUALITY = savedQuality
    resetSettings()
  })

  test('a PNG round-trips to a smaller WebP payload', async () => {
    const original = gradientPng()
    const compressed = await compressImageBase64(original, 'image/png')

    expect(compressed.mediaType).toBe('image/webp')
    expect(compressed.data.length).toBeLessThan(original.length)

    // The bytes really are WebP, not a PNG with a relabelled media type: the
    // stored `media_type` is what the Claude API is told, so a lie here would
    // only surface as an API error much later.
    const meta = await new Bun.Image(Buffer.from(compressed.data, 'base64')).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(128)
    expect(meta.height).toBe(128)
  })

  test('lower quality yields a smaller payload', async () => {
    const original = gradientPng()
    const high = await compressImageBase64(original, 'image/png', 90)
    const low = await compressImageBase64(original, 'image/png', 20)
    expect(low.data.length).toBeLessThan(high.data.length)
  })

  test('an indexed PNG keeps its transparency through the conversion', async () => {
    const original = await indexedTransparentPng()

    // Guard the fixture itself: if the quantiser ever stops writing a palette
    // the test would still pass while no longer testing the palette path.
    const layout = readPngLayout(Buffer.from(original, 'base64'))
    expect(layout.colourType).toBe(3)
    expect(layout.chunks).toContain('tRNS')

    const compressed = await compressImageBase64(original, 'image/png')
    expect(compressed.mediaType).toBe('image/webp')

    const meta = await new Bun.Image(Buffer.from(compressed.data, 'base64')).metadata()
    expect(meta.format).toBe('webp')

    expect(await alphaAt(compressed.data, 2, 2)).toBe(0)
    expect(await alphaAt(compressed.data, 20, 20)).toBe(255)
  })

  test('garbage base64 comes back unchanged', async () => {
    const garbage = 'bm90IGFuIGltYWdlIGF0IGFsbA=='
    const compressed = await compressImageBase64(garbage, 'image/png')
    expect(compressed.data).toBe(garbage)
    expect(compressed.mediaType).toBe('image/png')
  })

  test('a truncated PNG comes back unchanged', async () => {
    const truncated = gradientPng().slice(0, 40)
    const compressed = await compressImageBase64(truncated, 'image/png')
    expect(compressed.data).toBe(truncated)
    expect(compressed.mediaType).toBe('image/png')
  })
})

describe('IMAGE_CONVERT_TO_WEBP=false', () => {
  const saved = process.env.IMAGE_CONVERT_TO_WEBP

  beforeAll(() => {
    process.env.IMAGE_CONVERT_TO_WEBP = 'false'
    resetSettings()
  })

  afterAll(() => {
    if (saved === undefined) delete process.env.IMAGE_CONVERT_TO_WEBP
    else process.env.IMAGE_CONVERT_TO_WEBP = saved
    resetSettings()
  })

  test('a perfectly good PNG is left alone', async () => {
    const original = gradientPng()

    const direct = await compressImageBase64(original, 'image/png')
    expect(direct.data).toBe(original)
    expect(direct.mediaType).toBe('image/png')

    const wrapped = await tryCompressImage(original, 'image/png', 'world 1')
    expect(wrapped.data).toBe(original)
    expect(wrapped.mediaType).toBe('image/png')
  })
})

describe('tryCompressImage', () => {
  const saved = process.env.IMAGE_CONVERT_TO_WEBP

  beforeAll(() => {
    process.env.IMAGE_CONVERT_TO_WEBP = 'true'
    resetSettings()
  })

  afterAll(() => {
    if (saved === undefined) delete process.env.IMAGE_CONVERT_TO_WEBP
    else process.env.IMAGE_CONVERT_TO_WEBP = saved
    resetSettings()
  })

  test('compresses when both inputs are present', async () => {
    const original = gradientPng()
    const result = await tryCompressImage(original, 'image/png', 'world 7')
    expect(result.mediaType).toBe('image/webp')
    expect(result.data!.length).toBeLessThan(original.length)
  })

  test.each([
    ['both null', null, null, null, null],
    ['no data', null, 'image/png', null, 'image/png'],
    ['no media type', 'aGk=', null, 'aGk=', null],
    ['empty data', '', 'image/png', '', 'image/png'],
    ['empty media type', 'aGk=', '', 'aGk=', ''],
    ['undefined', undefined, undefined, null, null],
  ] as const)(
    'passes %s straight through',
    async (_label, data, mediaType, expectedData, expectedMediaType) => {
      // Python returns *both* arguments untouched when either is falsy, so an
      // absent payload keeps its media type and vice versa. `undefined` has no
      // Python counterpart and is normalised to `null`, which is what the
      // column stores.
      const result = await tryCompressImage(data, mediaType, 'world 1')
      expect(result.data).toBe(expectedData)
      expect(result.mediaType).toBe(expectedMediaType)
    },
  )

  test('returns the original when the payload is not an image', async () => {
    const garbage = 'bm90IGFuIGltYWdlIGF0IGFsbA=='
    const result = await tryCompressImage(garbage, 'image/png', '')
    expect(result.data).toBe(garbage)
    expect(result.mediaType).toBe('image/png')
  })
})
