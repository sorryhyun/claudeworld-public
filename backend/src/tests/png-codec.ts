/**
 * A minimal PNG encoder/decoder for the image tests.
 *
 * `Bun.Image` is a decode → transform → encode pipeline over whole files: it
 * takes no raw pixel buffer in and gives none back, and its `metadata()` is
 * width/height/format only. The image tests need exactly those three missing
 * things — synthesise pixels, read a pixel back, and look at how a PNG is
 * actually laid out — so they are provided here rather than by pulling a
 * native image library into the dependency tree for test fixtures alone.
 *
 * Deliberately narrow: 8-bit non-interlaced RGB/RGBA, which is what
 * `encodeRgbPng`/`encodeRgbaPng` write and what `Bun.Image.png()` emits.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 8-bit RGB (channels 3, colour type 2) or RGBA (channels 4, colour type 6). */
function encodePng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = channels === 3 ? 2 : 6

  // One filter byte per scanline; filter 0 (None) keeps the encoder honest and
  // small — the deflate stream, not the filter, is what shrinks the fixtures.
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const idat = new Uint8Array(deflateSync(raw))
  return Uint8Array.from([
    ...SIGNATURE,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', new Uint8Array(0)),
  ])
}

export function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  return encodePng(pixels, width, height, 3)
}

export function encodeRgbaPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  return encodePng(pixels, width, height, 4)
}

export interface PngLayout {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  /** 0 grey · 2 RGB · 3 indexed · 4 grey+alpha · 6 RGBA. */
  readonly colourType: number
  readonly interlaced: boolean
  /** Chunk types in file order, e.g. `['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']`. */
  readonly chunks: readonly string[]
}

/**
 * What the file actually says about itself — the indexed/transparent
 * distinctions `Bun.Image.metadata()` does not carry.
 */
export function readPngLayout(png: Uint8Array): PngLayout {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: string[] = []
  let ihdr: DataView | undefined

  let offset = SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    chunks.push(type)
    if (type === 'IHDR') ihdr = new DataView(png.buffer, png.byteOffset + offset + 8, length)
    offset += 12 + length
    if (type === 'IEND') break
  }

  if (!ihdr) throw new Error('not a PNG: no IHDR')
  return {
    width: ihdr.getUint32(0),
    height: ihdr.getUint32(4),
    bitDepth: ihdr.getUint8(8),
    colourType: ihdr.getUint8(9),
    interlaced: ihdr.getUint8(12) !== 0,
    chunks,
  }
}

export interface DecodedPng {
  readonly width: number
  readonly height: number
  /** Always 4 channels, alpha forced to 255 for an RGB source. */
  readonly rgba: Uint8Array
}

/** 8-bit RGB or RGBA, non-interlaced — the two shapes `Bun.Image.png()` emits. */
export function decodePngToRgba(png: Uint8Array): DecodedPng {
  const layout = readPngLayout(png)
  if (layout.bitDepth !== 8 || layout.interlaced || (layout.colourType !== 2 && layout.colourType !== 6)) {
    throw new Error(
      `unsupported PNG: depth ${layout.bitDepth}, colour type ${layout.colourType}` +
        `${layout.interlaced ? ', interlaced' : ''}`,
    )
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const parts: Uint8Array[] = []
  let offset = SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
    if (type === 'IEND') break
  }

  const raw = new Uint8Array(inflateSync(Buffer.concat(parts)))
  const { width, height } = layout
  const channels = layout.colourType === 2 ? 3 : 4
  const stride = width * channels
  const out = new Uint8Array(stride * height)

  // Undo the per-scanline filter in place; each line is reconstructed against
  // the already-reconstructed line above it, which is why this runs top-down.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[y * stride + i - channels]! : 0
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels]! : 0
      let value = line[i]!
      switch (filter) {
        case 0: break
        case 1: value += left; break
        case 2: value += up; break
        case 3: value += (left + up) >> 1; break
        case 4: value += paeth(left, up, upLeft); break
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      out[y * stride + i] = value & 0xff
    }
  }

  if (channels === 4) return { width, height, rgba: out }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i]!
    rgba[j + 1] = out[i + 1]!
    rgba[j + 2] = out[i + 2]!
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}
