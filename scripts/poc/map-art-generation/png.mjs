// Minimal, dependency-free PNG encoder for this throwaway research spike.
//
// No image library (sharp/canvas/pngjs/etc.) is a project dependency, and
// this is a standalone Node script outside the Next.js/browser runtime
// renderMapThumbnail relies on (HTMLCanvasElement doesn't exist here) — so
// rather than adding a real dependency for a spike, this hand-rolls the
// tiny slice of the PNG spec needed: an uncompressed-filter (filter type 0
// per scanline), 8-bit RGB, non-interlaced image. Node's built-in zlib
// covers both pieces PNG needs beyond that (DEFLATE for IDAT, CRC-32 for
// each chunk's trailer) natively — zlib.crc32 has been built into Node
// since 20.12/21, so no separate CRC table implementation is needed either.
import { deflateSync, crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
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
 * padding) as a PNG file buffer. This is the only encode shape the PoC's
 * control-image and output-saving code needs.
 */
export function encodeRgbPng(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(
      `encodeRgbPng: buffer length ${rgb.length} does not match ${width}x${height}x3`
    );
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

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
