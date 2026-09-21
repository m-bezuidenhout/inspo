/**
 * Reads the pixel dimensions out of an image file's header.
 *
 * Every image format writes its width and height in the first few hundred
 * bytes, so this reads a small chunk rather than decoding the picture. That
 * keeps the library fast to scan and avoids pulling in an image dependency.
 *
 * Returns { width, height } or null if the format isn't one we can read.
 * AVIF is the known gap - the browser measures those before upload instead.
 */

const fs = require('fs/promises');

const HEADER_BYTES = 65536;

function readPng(buf) {
  // 8-byte signature, then an IHDR chunk whose first two fields are the size.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGif(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readBmp(buf) {
  if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
}

function readJpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1; // Resync past padding bytes.
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0-SOF15 carry the frame size. SOF4/8/12 are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Standalone markers carry no length field.
      continue;
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return null;
}

function readWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // 14 bits each, packed across four bytes after the 1-byte signature.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Canvas size is stored as 24-bit little-endian, minus one.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function readSvg(buf) {
  const text = buf.toString('utf8', 0, Math.min(buf.length, 8192));
  const tag = text.match(/<svg[^>]*>/i);
  if (!tag) return null;
  const w = tag[0].match(/\bwidth\s*=\s*["']\s*([\d.]+)/i);
  const h = tag[0].match(/\bheight\s*=\s*["']\s*([\d.]+)/i);
  if (w && h) return { width: parseFloat(w[1]), height: parseFloat(h[1]) };

  // No explicit size - fall back to the viewBox, which is what most exported
  // SVGs rely on anyway.
  const box = tag[0].match(/viewBox\s*=\s*["']\s*[\d.-]+[,\s]+[\d.-]+[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (box) return { width: parseFloat(box[1]), height: parseFloat(box[2]) };
  return null;
}

const READERS = [readPng, readJpeg, readGif, readWebp, readBmp, readSvg];

/**
 * Reads the size out of bytes already in hand. This is the real implementation;
 * the path-based version below is a convenience for files on disk. Hosted
 * storage hands us a buffer and never has a path at all.
 */
function imageSizeFromBuffer(buf) {
  if (!buf || buf.length === 0) return null;
  const header = buf.length > HEADER_BYTES ? buf.subarray(0, HEADER_BYTES) : buf;

  for (const read of READERS) {
    try {
      const size = read(header);
      if (size && size.width > 0 && size.height > 0) {
        return { width: Math.round(size.width), height: Math.round(size.height) };
      }
    } catch {
      // A truncated or malformed file just means we try the next reader.
    }
  }
  return null;
}

/** Reads only the header, so scanning a library never loads whole images. */
async function imageSize(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    return imageSizeFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { imageSize, imageSizeFromBuffer };
