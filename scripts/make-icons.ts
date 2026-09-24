/**
 * Builds the app icon and the tray icons from resources/icon-source.png.
 *
 * Put the artwork at resources/icon-source.png (square, ideally 512px or larger, PNG with
 * or without alpha) and run `npm run icons`. Output:
 *
 *   resources/icon.ico            multi-size Windows icon (16…256) — window + shortcut
 *   resources/icon.png            256px, used by Linux builds and the installer
 *   resources/tray-running.png    16px + @2x, full colour   — a session is running
 *   resources/tray-idle.png       16px + @2x, desaturated   — nothing is running
 *
 * Plain Node throughout: a small PNG decoder, a box-filter resampler and an ICO wrapper.
 * No image library, so there is nothing extra to audit or to break on a fresh machine.
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RESOURCES = join(process.cwd(), 'resources')
const SOURCE = join(RESOURCES, 'icon-source.png')

// ----------------------------------------------------------------- PNG common

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Bitmap {
  width: number
  height: number
  /** RGBA, 8 bits per channel. */
  data: Uint8Array
}

// ---------------------------------------------------------------- PNG decoding

/** Undoes the per-scanline PNG filters. */
function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const outRow = y * stride
    const prevRow = outRow - stride

    for (let x = 0; x < stride; x++) {
      const value = line[x]!
      const a = x >= bytesPerPixel ? out[outRow + x - bytesPerPixel]! : 0
      const b = y > 0 ? out[prevRow + x]! : 0
      const c = y > 0 && x >= bytesPerPixel ? out[prevRow + x - bytesPerPixel]! : 0

      let restored: number
      switch (filter) {
        case 0:
          restored = value
          break
        case 1:
          restored = value + a
          break
        case 2:
          restored = value + b
          break
        case 3:
          restored = value + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`Unsupported PNG filter type: ${filter}`)
      }
      out[outRow + x] = restored & 0xff
    }
  }
  return out
}

function decodePng(buffer: Buffer): Bitmap {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, index) => buffer[index] === byte)) {
    throw new Error('resources/icon-source.png is not a PNG file.')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colourType = 6
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colourType = data[9]!
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported — re-save without interlacing.')
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') transparency = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
  }

  if (bitDepth !== 8) throw new Error(`Only 8-bit PNGs are supported (this one is ${bitDepth}-bit).`)

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType]
  if (!channels) throw new Error(`Unsupported PNG colour type: ${colourType}`)

  const pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels)
  const rgba = new Uint8Array(width * height * 4)

  for (let i = 0; i < width * height; i++) {
    const source = i * channels
    const target = i * 4
    switch (colourType) {
      case 0: // greyscale
        rgba[target] = rgba[target + 1] = rgba[target + 2] = pixels[source]!
        rgba[target + 3] = 255
        break
      case 4: // greyscale + alpha
        rgba[target] = rgba[target + 1] = rgba[target + 2] = pixels[source]!
        rgba[target + 3] = pixels[source + 1]!
        break
      case 2: // RGB
        rgba[target] = pixels[source]!
        rgba[target + 1] = pixels[source + 1]!
        rgba[target + 2] = pixels[source + 2]!
        rgba[target + 3] = 255
        break
      case 3: {
        // palette
        const index = pixels[source]!
        rgba[target] = palette![index * 3]!
        rgba[target + 1] = palette![index * 3 + 1]!
        rgba[target + 2] = palette![index * 3 + 2]!
        rgba[target + 3] = transparency?.[index] ?? 255
        break
      }
      default: // RGBA
        rgba[target] = pixels[source]!
        rgba[target + 1] = pixels[source + 1]!
        rgba[target + 2] = pixels[source + 2]!
        rgba[target + 3] = pixels[source + 3]!
    }
  }

  return { width, height, data: rgba }
}

// ---------------------------------------------------------------- PNG encoding

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(data.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// -------------------------------------------------------------------- resample

/**
 * Box-filter downscale with premultiplied alpha.
 *
 * Premultiplying matters: averaging straight RGBA makes transparent pixels bleed their
 * colour into the edges, which at 16px turns a crisp icon into a muddy one.
 */
function resize(source: Bitmap, size: number): Bitmap {
  const out = new Uint8Array(size * size * 4)
  const scaleX = source.width / size
  const scaleY = source.height / size

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY))

    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0

      for (let sy = y0; sy < y1 && sy < source.height; sy++) {
        for (let sx = x0; sx < x1 && sx < source.width; sx++) {
          const index = (sy * source.width + sx) * 4
          const alpha = source.data[index + 3]! / 255
          r += source.data[index]! * alpha
          g += source.data[index + 1]! * alpha
          b += source.data[index + 2]! * alpha
          a += source.data[index + 3]!
          count++
        }
      }

      const target = (y * size + x) * 4
      const averageAlpha = a / count
      const unpremultiply = averageAlpha > 0 ? 255 / averageAlpha : 0
      out[target] = Math.min(255, Math.round((r / count) * unpremultiply))
      out[target + 1] = Math.min(255, Math.round((g / count) * unpremultiply))
      out[target + 2] = Math.min(255, Math.round((b / count) * unpremultiply))
      out[target + 3] = Math.round(averageAlpha)
    }
  }

  return { width: size, height: size, data: out }
}

/**
 * Makes the artwork's background transparent.
 *
 * A rounded-square icon exported on a white canvas shows white corners once Windows draws
 * it on a shortcut or in the taskbar. Rather than guessing a corner radius, this flood-fills
 * inward from the four corners: the fill follows whatever shape the artwork actually has.
 *
 * Pixels close to the background colour go fully transparent; pixels part-way between the
 * background and the artwork get partial alpha, which preserves the anti-aliased edge
 * instead of leaving a hard white fringe.
 */
function removeBackground(bitmap: Bitmap, hard = 40, soft = 120): Bitmap {
  const { width, height } = bitmap
  const data = new Uint8Array(bitmap.data)

  const corner = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4
    return [data[i]!, data[i + 1]!, data[i + 2]!]
  }

  // Only strip if the four corners agree — otherwise the art bleeds to the edge on purpose.
  const corners = [
    corner(0, 0),
    corner(width - 1, 0),
    corner(0, height - 1),
    corner(width - 1, height - 1)
  ]
  const [br, bg, bb] = corners[0]!
  const consistent = corners.every(
    ([r, g, b]) => Math.hypot(r - br, g - bg, b - bb) < hard
  )
  if (!consistent) {
    console.log('Corners differ — leaving the background alone.')
    return bitmap
  }

  const distance = (i: number): number =>
    Math.hypot(data[i]! - br, data[i + 1]! - bg, data[i + 2]! - bb)

  const visited = new Uint8Array(width * height)
  const queue: number[] = [0, width - 1, (height - 1) * width, height * width - 1]
  let stripped = 0

  while (queue.length > 0) {
    const pixel = queue.pop()!
    if (visited[pixel]) continue
    visited[pixel] = 1

    const i = pixel * 4
    const d = distance(i)
    if (d >= soft) continue // clearly artwork — stop here

    // 0 at the background colour, 255 once it is clearly the artwork.
    data[i + 3] = d <= hard ? 0 : Math.round(((d - hard) / (soft - hard)) * 255)
    if (data[i + 3] === 0) stripped++

    const x = pixel % width
    const y = (pixel - x) / width
    if (x > 0) queue.push(pixel - 1)
    if (x < width - 1) queue.push(pixel + 1)
    if (y > 0) queue.push(pixel - width)
    if (y < height - 1) queue.push(pixel + width)
  }

  console.log(`Background stripped: ${stripped} pixels made transparent.`)
  return { width, height, data }
}

/** Desaturates and dims — the tray's "not tracking" state. */
function toIdle(bitmap: Bitmap): Bitmap {
  const data = new Uint8Array(bitmap.data)
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    const dimmed = Math.round(luma * 0.85)
    data[i] = data[i + 1] = data[i + 2] = dimmed
  }
  return { ...bitmap, data }
}

// -------------------------------------------------------------------------- ICO

/**
 * 32-bit BMP payload for an ICO entry.
 *
 * Windows only handles PNG-compressed ICO entries reliably at 256x256. At the smaller
 * sizes — exactly the ones used for shortcuts, the taskbar and Explorer — a PNG payload
 * renders with the alpha channel ignored, which is what puts white corners back on a
 * rounded icon. So: BMP below 256, PNG at 256.
 *
 * Quirks of the format, all of them load-bearing:
 *   - biHeight is doubled, because the entry stores the colour bitmap and an AND mask
 *   - rows are bottom-up
 *   - the AND mask is still required even for 32-bit images; all zeros means "use alpha"
 */
function encodeBmp(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // colour bitmap + AND mask
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB, uncompressed
  header.writeUInt32LE(width * height * 4, 20) // biSizeImage

  // BGRA, bottom-up.
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4
    const targetRow = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = sourceRow + x * 4
      const t = targetRow + x * 4
      pixels[t] = data[s + 2]! // B
      pixels[t + 1] = data[s + 1]! // G
      pixels[t + 2] = data[s]! // R
      pixels[t + 3] = data[s + 3]! // A
    }
  }

  // AND mask: 1 bit per pixel, each row padded to a 4-byte boundary. Zeros throughout.
  const maskStride = Math.ceil(width / 32) * 4
  const mask = Buffer.alloc(maskStride * height)

  return Buffer.concat([header, pixels, mask])
}

function encodeIco(images: Array<{ size: number; payload: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries: Buffer[] = []

  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry[0] = image.size >= 256 ? 0 : image.size // 0 encodes 256
    entry[1] = image.size >= 256 ? 0 : image.size
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.payload.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.payload.length
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.payload)])
}

// ------------------------------------------------------------------------ main

mkdirSync(RESOURCES, { recursive: true })

if (!existsSync(SOURCE)) {
  console.error(
    `Missing artwork.\n\n  Save the icon as: ${SOURCE}\n` +
      '  Square PNG, 512px or larger, not interlaced, 8 bits per channel.\n\n' +
      '  Then run: npm run icons'
  )
  process.exit(1)
}

const decoded = decodePng(readFileSync(SOURCE))
if (decoded.width !== decoded.height) {
  console.warn(`Warning: the source is ${decoded.width}x${decoded.height}, not square. It will be squashed.`)
}

// Strip the flat background before resampling, so the corners never bleed white.
const source = removeBackground(decoded)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
writeFileSync(
  join(RESOURCES, 'icon.ico'),
  encodeIco(
    icoSizes.map((size) => {
      const scaled = resize(source, size)
      // PNG only at 256; anything smaller must be BMP or Windows drops the alpha.
      return { size, payload: size >= 256 ? encodePng(scaled) : encodeBmp(scaled) }
    })
  )
)
writeFileSync(join(RESOURCES, 'icon.png'), encodePng(resize(source, 256)))

const tray16 = resize(source, 16)
const tray32 = resize(source, 32)
writeFileSync(join(RESOURCES, 'tray-running.png'), encodePng(tray16))
writeFileSync(join(RESOURCES, 'tray-running@2x.png'), encodePng(tray32))
writeFileSync(join(RESOURCES, 'tray-idle.png'), encodePng(toIdle(tray16)))
writeFileSync(join(RESOURCES, 'tray-idle@2x.png'), encodePng(toIdle(tray32)))

console.log(`Source: ${source.width}x${source.height}`)
console.log(`Wrote icon.ico (${icoSizes.join(', ')}px), icon.png and 4 tray icons to resources/`)
