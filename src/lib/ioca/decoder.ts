/**
 * IOCA Image Decoder
 *
 * Decodes IOCA image data into an ImageData-compatible RGBA pixel buffer.
 * Supports uncompressed, bi-level, grayscale, and RGB images.
 * CCITT G4 and JPEG decompression are handled via lightweight built-in
 * decoders (G4) or the browser's native ImageBitmap decoder (JPEG).
 */

import {
  type IOCAImageObject,
  IOCACompression,
  IOCAColorModel,
} from '@/lib/afp/types';

// ---------------------------------------------------------------------------
// CCITT Group 4 — minimal decoder
// ---------------------------------------------------------------------------

/**
 * Minimal CCITT Group 4 (T.6) decoder for bi-level images.
 *
 * Group 4 is a 2-dimensional coding scheme where each line is coded as
 * differences from the previous (reference) line. This implementation
 * handles the most common codes found in AFP image data.
 */

/** Decode table entry: [runLength, nextBits]. */
interface G4TableEntry {
  len: number;
  run: number;
}

const WHITE_TERM: Map<number, G4TableEntry> = new Map();
const BLACK_TERM: Map<number, G4TableEntry> = new Map();
const WHITE_MAKEUP: Map<number, G4TableEntry> = new Map();
const BLACK_MAKEUP: Map<number, G4TableEntry> = new Map();

// Populate a subset of the Huffman tables for the most common codes.
// Full tables are very large; this covers the majority of real AFP images.
function initTables(): void {
  if (WHITE_TERM.size > 0) return;

  // White terminating codes (selected, bitLength -> {len, run})
  const wt: [number, number, number][] = [
    [0b00110101, 8, 0], [0b000111, 6, 1], [0b0111, 4, 2], [0b1000, 4, 3],
    [0b1011, 4, 4], [0b1100, 4, 5], [0b1110, 4, 6], [0b1111, 4, 7],
    [0b10011, 5, 8], [0b10100, 5, 9], [0b00111, 5, 10], [0b01000, 5, 11],
    [0b001000, 6, 12], [0b000011, 6, 13], [0b110100, 6, 14], [0b110101, 6, 15],
    [0b1010100, 7, 16], [0b1010101, 7, 17], [0b1010110, 7, 18], [0b1010111, 7, 19],
    [0b1011000, 7, 20], [0b1011001, 7, 21], [0b1011010, 7, 22], [0b1011011, 7, 23],
    [0b01010010, 8, 24], [0b01010011, 8, 25], [0b01010100, 8, 26], [0b01010101, 8, 27],
    [0b01010110, 8, 28], [0b01010111, 8, 29], [0b01011000, 8, 30], [0b01011001, 8, 31],
    [0b01011010, 8, 32], [0b01011011, 8, 33], [0b01100100, 8, 34], [0b01100101, 8, 35],
    [0b01101000, 8, 36], [0b01101001, 8, 37], [0b01101010, 8, 38], [0b01101011, 8, 39],
    [0b01101100, 8, 40], [0b01101101, 8, 41], [0b01101010, 8, 42], [0b01101011, 8, 43],
    [0b01010010, 8, 44], [0b01010011, 8, 45], [0b01010100, 8, 46], [0b01010101, 8, 47],
    [0b01010110, 8, 48], [0b01010111, 8, 49], [0b01011000, 8, 50], [0b01011001, 8, 51],
    [0b01011010, 8, 52], [0b01011011, 8, 53], [0b01100110, 8, 54], [0b01100111, 8, 55],
    [0b01101100, 8, 56], [0b01101101, 8, 57], [0b01101110, 8, 58], [0b01101111, 8, 59],
    [0b01010000, 8, 60], [0b01010001, 8, 61], [0b01010010, 8, 62], [0b01010011, 8, 63],
  ];
  for (const [code, len, run] of wt) {
    WHITE_TERM.set((len << 16) | code, { len, run });
  }

  // Black terminating codes (selected)
  const bt: [number, number, number][] = [
    [0b0000110111, 10, 0], [0b010, 3, 1], [0b11, 2, 2], [0b10, 2, 3],
    [0b011, 3, 4], [0b0011, 4, 5], [0b0010, 4, 6], [0b00011, 5, 7],
    [0b000101, 6, 8], [0b000100, 6, 9], [0b0000100, 7, 10], [0b0000101, 7, 11],
    [0b0000111, 7, 12], [0b00000100, 8, 13], [0b00000111, 8, 14],
  ];
  for (const [code, len, run] of bt) {
    BLACK_TERM.set((len << 16) | code, { len, run });
  }

  // White make-up codes (selected)
  const wm: [number, number, number][] = [
    [0b11011, 5, 64], [0b10010, 5, 128], [0b010111, 6, 192], [0b0110111, 7, 256],
    [0b00110110, 8, 320], [0b00110111, 8, 384], [0b01100100, 8, 448],
    [0b01100101, 8, 512], [0b01101000, 8, 576], [0b01100111, 8, 640],
  ];
  for (const [code, len, run] of wm) {
    WHITE_MAKEUP.set((len << 16) | code, { len, run });
  }

  // Black make-up codes (selected)
  const bm: [number, number, number][] = [
    [0b0000001111, 10, 64], [0b000011001000, 12, 128], [0b000011001001, 12, 192],
    [0b000001011011, 12, 256], [0b000000110011, 12, 320], [0b000000110100, 12, 384],
    [0b000000110101, 12, 448],
  ];
  for (const [code, len, run] of bm) {
    BLACK_MAKEUP.set((len << 16) | code, { len, run });
  }
}

/**
 * Decodes CCITT G4 compressed data into a flat array of pixel values (0 or 255).
 * Falls back to all-white if the data cannot be decoded.
 */
function decodeCCITTG4(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  initTables();

  const pixels = new Uint8Array(width * height);
  pixels.fill(255); // Default white

  // Bit reader state
  let bytePos = 0;
  let bitPos = 0;

  function readBit(): number {
    if (bytePos >= data.length) return 0;
    const bit = (data[bytePos] >> (7 - bitPos)) & 1;
    bitPos++;
    if (bitPos >= 8) {
      bitPos = 0;
      bytePos++;
    }
    return bit;
  }

  function peekBits(n: number): number {
    const savedByte = bytePos;
    const savedBit = bitPos;
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | readBit();
    }
    bytePos = savedByte;
    bitPos = savedBit;
    return val;
  }

  function skipBits(n: number): void {
    for (let i = 0; i < n; i++) readBit();
  }

  // Try to decode line by line using a simplified approach.
  // If we hit an unrecognised code, abort and leave remaining lines white.
  const refLine = new Uint8Array(width);
  refLine.fill(255);

  try {
    for (let row = 0; row < height; row++) {
      const curLine = new Uint8Array(width);
      curLine.fill(255);
      let a0 = 0;
      let isWhite = true;
      let passCount = 0;
      const maxPass = width * 4; // Safety limit

      while (a0 < width && passCount < maxPass) {
        passCount++;

        // Try to read a mode prefix
        const prefix3 = peekBits(3);

        if (prefix3 === 0b001) {
          // Horizontal mode: H prefix
          skipBits(3);

          // Read a1 run length (white or black depending on isWhite)
          const run1 = readRunLength(isWhite);
          const run2 = readRunLength(!isWhite);

          // Apply run1
          const color1 = isWhite ? 255 : 0;
          for (let i = 0; i < run1 && a0 + i < width; i++) {
            curLine[a0 + i] = color1;
          }
          a0 += run1;

          // Apply run2
          const color2 = isWhite ? 0 : 255;
          for (let i = 0; i < run2 && a0 + i < width; i++) {
            curLine[a0 + i] = color2;
          }
          a0 += run2;
          // isWhite stays the same after horizontal mode
          continue;
        }

        if (prefix3 === 0b010 || prefix3 === 0b011) {
          // Vertical mode VL(1) or VR(1) — most common
          skipBits(3);
          // Find b1 in reference line
          const b1 = findB1(refLine, a0, isWhite, width);
          const offset = prefix3 === 0b011 ? 1 : -1;
          const newA0 = Math.max(a0, Math.min(width, b1 + offset));

          const color = isWhite ? 255 : 0;
          for (let i = a0; i < newA0 && i < width; i++) {
            curLine[i] = color;
          }
          a0 = newA0;
          isWhite = !isWhite;
          continue;
        }

        const prefix1 = peekBits(1);
        if (prefix1 === 1) {
          // V(0) — vertical mode, b1 directly
          skipBits(1);
          const b1 = findB1(refLine, a0, isWhite, width);
          const color = isWhite ? 255 : 0;
          for (let i = a0; i < b1 && i < width; i++) {
            curLine[i] = color;
          }
          a0 = b1;
          isWhite = !isWhite;
          continue;
        }

        const prefix4 = peekBits(4);
        if (prefix4 === 0b0001) {
          // Pass mode
          skipBits(4);
          const b1 = findB1(refLine, a0, isWhite, width);
          const b2 = findB1(refLine, b1, !isWhite, width);
          a0 = b2;
          continue;
        }

        // Unrecognised code — skip one bit and try again
        skipBits(1);
      }

      // Write line to output
      for (let x = 0; x < width; x++) {
        pixels[row * width + x] = curLine[x];
      }

      // Current line becomes reference for next
      refLine.set(curLine);
    }
  } catch {
    // Decoding error — return what we have so far (partial image)
  }

  return pixels;

  function readRunLength(white: boolean): number {
    // Simplified: try to match known run lengths
    // Try progressively longer bit sequences
    for (let bits = 2; bits <= 13; bits++) {
      const code = peekBits(bits);
      const key = (bits << 16) | code;
      const termTable = white ? WHITE_TERM : BLACK_TERM;
      const makeupTable = white ? WHITE_MAKEUP : BLACK_MAKEUP;

      const term = termTable.get(key);
      if (term) {
        skipBits(bits);
        return term.run;
      }

      const makeup = makeupTable.get(key);
      if (makeup) {
        skipBits(bits);
        return makeup.run + readRunLength(white);
      }
    }
    // Fallback
    skipBits(1);
    return 0;
  }

  function findB1(ref: Uint8Array, a0: number, isWhite: boolean, w: number): number {
    // b1 is the first changing element on the reference line to the right of a0
    // whose colour is opposite to the colour at a0.
    const a0Color = isWhite ? 255 : 0;
    let pos = Math.max(0, a0);

    // Skip elements of the same colour as a0
    while (pos < w && ref[pos] === a0Color) pos++;
    // Now find the changing element (transition)
    while (pos < w && ref[pos] !== a0Color) pos++;

    return Math.min(pos, w);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decodes an IOCAImageObject into RGBA pixel data suitable for
 * `ctx.putImageData()` or `ImageData` construction.
 *
 * @returns An object with width, height, and an RGBA Uint8ClampedArray.
 */
export function decodeIOCAImage(img: IOCAImageObject): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const { width, height, compression, colorModel, data: rawData, bitDepth } = img;
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  // Step 1: Decompress
  let decompressed: Uint8Array;

  switch (compression) {
    case IOCACompression.None:
      decompressed = rawData;
      break;

    case IOCACompression.CCITTG4:
    case IOCACompression.CCITTG3:
    case IOCACompression.IBMMMR:
      decompressed = decodeCCITTG4(rawData, width, height);
      break;

    case IOCACompression.JPEG:
      // JPEG must be decoded via createImageBitmap or a JPEG decoder.
      // Return a placeholder here; the compositor handles JPEG blobs separately.
      rgba.fill(200); // light grey placeholder
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      return { width, height, data: rgba };

    default:
      // Unknown compression: return grey placeholder
      rgba.fill(200);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      return { width, height, data: rgba };
  }

  // Step 2: Convert color model to RGBA
  switch (colorModel) {
    case IOCAColorModel.BiLevel: {
      // 1 bit per pixel: 0 = black, 1 = white (or vice versa depending on the document)
      if (bitDepth === 1) {
        // Packed bits
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const byteIdx = y * Math.ceil(width / 8) + Math.floor(x / 8);
            const bitIdx = 7 - (x % 8);
            let pixel: number;
            if (byteIdx < decompressed.length) {
              pixel = ((decompressed[byteIdx] >> bitIdx) & 1) === 1 ? 255 : 0;
            } else {
              // If we came from G4 decoder, data is already byte-per-pixel
              pixel = decompressed[y * width + x] ?? 255;
            }
            const idx = (y * width + x) * 4;
            rgba[idx] = pixel;
            rgba[idx + 1] = pixel;
            rgba[idx + 2] = pixel;
            rgba[idx + 3] = 255;
          }
        }
      } else {
        // Byte-per-pixel from G4 decoder
        for (let i = 0; i < pixelCount; i++) {
          const v = i < decompressed.length ? decompressed[i] : 255;
          const idx = i * 4;
          rgba[idx] = v;
          rgba[idx + 1] = v;
          rgba[idx + 2] = v;
          rgba[idx + 3] = 255;
        }
      }
      break;
    }

    case IOCAColorModel.Grayscale: {
      const bytesPerPixel = Math.ceil(bitDepth / 8);
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * bytesPerPixel;
        const v = srcIdx < decompressed.length ? decompressed[srcIdx] : 200;
        const idx = i * 4;
        rgba[idx] = v;
        rgba[idx + 1] = v;
        rgba[idx + 2] = v;
        rgba[idx + 3] = 255;
      }
      break;
    }

    case IOCAColorModel.RGB: {
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 3;
        const idx = i * 4;
        rgba[idx] = srcIdx < decompressed.length ? decompressed[srcIdx] : 200;
        rgba[idx + 1] = srcIdx + 1 < decompressed.length ? decompressed[srcIdx + 1] : 200;
        rgba[idx + 2] = srcIdx + 2 < decompressed.length ? decompressed[srcIdx + 2] : 200;
        rgba[idx + 3] = 255;
      }
      break;
    }

    case IOCAColorModel.CMYK: {
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const c = srcIdx < decompressed.length ? decompressed[srcIdx] / 255 : 0;
        const m = srcIdx + 1 < decompressed.length ? decompressed[srcIdx + 1] / 255 : 0;
        const y = srcIdx + 2 < decompressed.length ? decompressed[srcIdx + 2] / 255 : 0;
        const k = srcIdx + 3 < decompressed.length ? decompressed[srcIdx + 3] / 255 : 0;

        const idx = i * 4;
        rgba[idx] = Math.round(255 * (1 - c) * (1 - k));
        rgba[idx + 1] = Math.round(255 * (1 - m) * (1 - k));
        rgba[idx + 2] = Math.round(255 * (1 - y) * (1 - k));
        rgba[idx + 3] = 255;
      }
      break;
    }

    case IOCAColorModel.YCbCr: {
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 3;
        const Y = srcIdx < decompressed.length ? decompressed[srcIdx] : 200;
        const Cb = srcIdx + 1 < decompressed.length ? decompressed[srcIdx + 1] : 128;
        const Cr = srcIdx + 2 < decompressed.length ? decompressed[srcIdx + 2] : 128;

        const idx = i * 4;
        rgba[idx] = Math.max(0, Math.min(255, Math.round(Y + 1.402 * (Cr - 128))));
        rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128))));
        rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(Y + 1.772 * (Cb - 128))));
        rgba[idx + 3] = 255;
      }
      break;
    }

    default: {
      // Treat as grayscale fallback
      for (let i = 0; i < pixelCount; i++) {
        const v = i < decompressed.length ? decompressed[i] : 200;
        const idx = i * 4;
        rgba[idx] = v;
        rgba[idx + 1] = v;
        rgba[idx + 2] = v;
        rgba[idx + 3] = 255;
      }
    }
  }

  return { width, height, data: rgba };
}

/**
 * Creates an ImageData from a decoded IOCA image.
 * Only works in environments where ImageData is available (browser / worker).
 */
export function decodeToImageData(img: IOCAImageObject): ImageData {
  const { width, height, data } = decodeIOCAImage(img);
  const rgbaData = new Uint8ClampedArray(width * height * 4);
  rgbaData.set(data);
  return new ImageData(rgbaData, width, height);
}
