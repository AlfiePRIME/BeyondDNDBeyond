// Minimal, dependency-free PNG encoder — ported verbatim (algorithm, not
// copy-pasted file) from the E1 research spike's
// scripts/poc/map-art-generation/png.mjs. No image library (sharp/canvas/
// pngjs/etc.) is a project dependency, and controlImage.ts's renderer
// produces a flat RGB byte buffer, not a browser <canvas> — encoding that
// buffer to an actual PNG file needs SOME encoder, and Node's built-in zlib
// covers both pieces PNG needs beyond raw pixels (DEFLATE for IDAT, CRC-32
// for each chunk's trailer) natively, so hand-rolling the tiny slice of the
// PNG spec this needs (uncompressed-filter-per-scanline, 8-bit RGB,
// non-interlaced) beats adding a real dependency for one call site.
import { deflateSync, crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encodes a flat RGB pixel buffer (width * height * 3 bytes, row-major, no
 * padding) as a PNG file buffer. This is the only encode shape
 * renderMapArtControlImage's output needs.
 */
export function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: buffer length ${rgb.length} does not match ${width}x${height}x3`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB (truecolor, no alpha)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // One filter-type byte (0 = None) prepended to every scanline, per spec.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const srcStart = y * stride;
    const dstStart = y * (stride + 1);
    raw[dstStart] = 0;
    rgb.copy(raw, dstStart + 1, srcStart, srcStart + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
