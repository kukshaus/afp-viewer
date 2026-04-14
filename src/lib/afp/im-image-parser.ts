/**
 * IM Image Parser — Legacy AFP Raster Image Format
 *
 * Two formats:
 * 1. BANDED: Cell header + FE92 band markers in same IRD (8bpp)
 * 2. UNBANDED: Cell header in tiny IRD, raw pixels in subsequent IRDs (1bpp)
 */

const TYPE_BII = 'D3A8FB';
const TYPE_EII = 'D3A9FB';
const TYPE_IDD2 = 'D3A6FB';
const TYPE_IRD = 'D3EEFB';

export interface IMImage {
  name: string;
  width: number;
  height: number;
  resolution: number;
  bitsPerPixel: number;
  compression: number; // 0=none, 3=G3, 8=G4
  data: Uint8Array;
}

export function parseIMImages(buffer: ArrayBuffer): Map<string, IMImage> {
  const images = new Map<string, IMImage>();
  const view = new DataView(buffer);
  let offset = 0;
  let inImage = false;
  let currentName = '';
  let irdChunks: Uint8Array[] = [];

  while (offset < buffer.byteLength) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 9 > buffer.byteLength) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }
    const typeId = toHex(view, offset);
    const dataLen = length - 8;
    const dataStart = offset + 9;

    if (typeId === TYPE_BII) {
      inImage = true;
      irdChunks = [];
      currentName = dataLen >= 8 ? extractName(new Uint8Array(buffer, dataStart, 8)) : '';
    } else if (typeId === TYPE_IRD && inImage) {
      if (dataLen > 0 && dataStart + dataLen <= buffer.byteLength) {
        irdChunks.push(new Uint8Array(buffer, dataStart, dataLen));
      }
    } else if (typeId === TYPE_EII && inImage) {
      if (irdChunks.length > 0) {
        const img = buildImage(currentName, irdChunks);
        if (img) images.set(currentName, img);
      }
      inImage = false;
    } else if (typeId === 'D3A8A8' && images.size >= 50) {
      break; // stop after finding enough images
    }

    const next = offset + 1 + length;
    if (next <= offset) break;
    offset = next;
  }
  return images;
}

export function parseIMImageAt(buffer: ArrayBuffer, startOffset: number): IMImage | null {
  const view = new DataView(buffer);
  let offset = startOffset;
  let inImage = false;
  let currentName = '';
  let irdChunks: Uint8Array[] = [];

  while (offset < buffer.byteLength) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 9 > buffer.byteLength) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }
    const typeId = toHex(view, offset);
    const dataLen = length - 8;
    const dataStart = offset + 9;

    if (typeId === TYPE_BII) {
      inImage = true;
      irdChunks = [];
      currentName = dataLen >= 8 ? extractName(new Uint8Array(buffer, dataStart, 8)) : '';
    } else if (typeId === TYPE_IRD && inImage) {
      if (dataLen > 0 && dataStart + dataLen <= buffer.byteLength) {
        irdChunks.push(new Uint8Array(buffer, dataStart, dataLen));
      }
    } else if (typeId === TYPE_EII && inImage) {
      return irdChunks.length > 0 ? buildImage(currentName, irdChunks) : null;
    }

    const next = offset + 1 + length;
    if (next <= offset) break;
    offset = next;
    if (offset - startOffset > 2 * 1024 * 1024) break;
  }
  return null;
}

function buildImage(name: string, chunks: Uint8Array[]): IMImage | null {
  // Step 1: Parse cell header (0x70) from first chunk that has it
  let width = 0;
  let height = 0;
  let bpp = 1;
  let compression = 0;
  let resolution = 300;
  let headerChunkIdx = -1;
  let pixelDataStart = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    if (chunks[ci].length > 5 && chunks[ci][0] === 0x70) {
      headerChunkIdx = ci;
      const c = chunks[ci];

      // Parse SDFs
      for (let j = 5; j < Math.min(c.length, 60); j++) {
        if (c[j] === 0x94 && j + 2 < c.length) {
          const slen = c[j + 1];
          if (slen >= 7 && j + 2 + slen <= c.length) {
            const sd = c.slice(j + 2, j + 2 + slen);
            const xr = (sd[1] << 8) | sd[2];
            width = (sd[5] << 8) | sd[6];
            if (slen > 8) height = (sd[7] << 8) | sd[8];
            if (xr > 100) resolution = Math.round(xr / 10);
          }
        }
        if (c[j] === 0x95 && j + 2 < c.length) {
          compression = c[j + 2];
        }
        if (c[j] === 0x96 && j + 2 < c.length) {
          bpp = c[j + 2];
        }
      }

      // Find FE92 marker (banded format) or end of header
      let foundFE92 = false;
      for (let j = 5; j < Math.min(c.length - 3, 100); j++) {
        if (c[j] === 0xFE && c[j + 1] === 0x92) {
          pixelDataStart = j;
          foundFE92 = true;
          break;
        }
      }

      if (!foundFE92) {
        pixelDataStart = c.length; // entire chunk is header, no pixel data
      }
      break;
    }
  }

  if (width <= 0) return null;

  const bytesPerRow = bpp === 8 ? width : Math.ceil(width / 8);

  // Step 2: Collect pixel data from all chunks
  // Skip FE92 band headers (4 bytes: FE 92 XX XX) wherever they appear
  const rawBytes: number[] = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    let start = (ci === headerChunkIdx) ? pixelDataStart : 0;
    const c = chunks[ci];

    // Skip FE92 band marker at the determined start position or chunk start
    if (c.length > start + 3 && c[start] === 0xFE && c[start + 1] === 0x92) {
      start += 4; // skip FE92 + 2-byte band size
    }

    for (let i = start; i < c.length; i++) {
      rawBytes.push(c[i]);
    }
  }

  if (rawBytes.length === 0) return null;

  // Step 3: Detect banded vs unbanded
  // For 1bpp: FE92 headers are already stripped, use unbanded (continuous data)
  // For 8bpp: FE92 bands within the cell header IRD define row boundaries
  let hasBands = false;
  if (bpp === 8) {
    for (let j = 0; j < Math.min(rawBytes.length - 1, 2000); j++) {
      if (rawBytes[j] === 0xFE && rawBytes[j + 1] === 0x92) {
        hasBands = true;
        break;
      }
    }
  }

  let flatData: Uint8Array;
  let imgHeight: number;

  if (hasBands) {
    // Banded: FE92 [width:2] [row_data:bytesPerRow]
    const rows: Uint8Array[] = [];
    let pos = 0;
    while (pos + 3 < rawBytes.length) {
      if (rawBytes[pos] === 0xFE && rawBytes[pos + 1] === 0x92) {
        const start = pos + 4;
        if (start + bytesPerRow <= rawBytes.length) {
          rows.push(new Uint8Array(rawBytes.slice(start, start + bytesPerRow)));
        }
        pos = start + bytesPerRow;
      } else {
        pos++;
      }
    }
    imgHeight = rows.length;
    flatData = new Uint8Array(imgHeight * bytesPerRow);
    for (let r = 0; r < imgHeight; r++) {
      flatData.set(rows[r], r * bytesPerRow);
    }
  } else {
    // Unbanded: raw pixel bytes
    imgHeight = height > 0 ? height : Math.floor(rawBytes.length / bytesPerRow);
    const dataSize = imgHeight * bytesPerRow;
    flatData = new Uint8Array(dataSize);
    for (let i = 0; i < dataSize && i < rawBytes.length; i++) {
      flatData[i] = rawBytes[i];
    }
  }

  if (imgHeight <= 0) return null;

  return { name, width, height: imgHeight, resolution, bitsPerPixel: bpp, data: flatData, compression };
}

export function renderIMImageToDataUrl(image: IMImage): string | null {
  if (typeof document === 'undefined') return null;

  const { width, height, bitsPerPixel: bpp } = image;
  const { data } = image;

  // For non-1bpp/8bpp color images (24bpp with IOCA tile compression — FE9C
  // markers, compression code 0x0D etc.), the data uses a proprietary IBM
  // tile-based color encoding that browsers cannot decode. Render a labeled
  // placeholder canvas at the correct dimensions so the page layout stays
  // intact and the user can see where the image is.
  if (bpp !== 1 && bpp !== 8) {
    return renderColorImagePlaceholder(width, height);
  }

  // Note: In AFP IM Image, SDF 0x95 compression=0x03 with flags=0x01
  // often means RAW uncompressed data, NOT G3 Huffman.
  // The data is raw 1-bit bitmap. No decompression needed.
  const bytesPerRow = bpp === 8 ? width : Math.ceil(width / 8);

  // Scale to fit within 500px wide, minimum 40px tall
  const maxW = 500;
  const scale = width > maxW ? maxW / width : 1;
  const rw = Math.round(width * scale);
  const rh = Math.max(40, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  if (!tctx) return null;

  const imgData = tctx.createImageData(width, height);
  const px = imgData.data;
  px.fill(255);

  if (bpp === 8) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bi = y * width + x;
        if (bi < data.length) {
          const g = data[bi];
          const idx = (y * width + x) * 4;
          px[idx] = g; px[idx + 1] = g; px[idx + 2] = g;
        }
      }
    }
  } else {
    // Auto-detect polarity: count 1-bits in a middle row (avoid border)
    const midRow = Math.min(Math.floor(height / 2), height - 1);
    let onesFirst = 0;
    for (let x = 0; x < Math.min(width, bytesPerRow * 8); x++) {
      const bi = midRow * bytesPerRow + Math.floor(x / 8);
      if (bi < data.length) onesFirst += ((data[bi] >> (7 - (x % 8))) & 1);
    }
    const zeroIsBlack = onesFirst > width / 2;

    // Helper: check if a given pixel is "black" according to polarity
    function isBitBlack(px2: number, py: number): boolean {
      const bi2 = py * bytesPerRow + Math.floor(px2 / 8);
      if (bi2 >= data.length) return false;
      const bitVal = (data[bi2] >> (7 - (px2 % 8))) & 1;
      return zeroIsBlack ? bitVal === 0 : bitVal === 1;
    }

    // Dynamic border detection: scan from left to find solid black columns
    // A column is a "border" if > 90% of pixels in it are black
    let borderLeft = 0;
    for (let col = 0; col < Math.min(8, width); col++) {
      let blackCount = 0;
      const sampleStep = Math.max(1, Math.floor(height / 100)); // sample ~100 rows
      let samples = 0;
      for (let row = 0; row < height; row += sampleStep) {
        samples++;
        if (isBitBlack(col, row)) blackCount++;
      }
      if (samples > 0 && blackCount / samples > 0.9) {
        borderLeft = col + 1;
      } else {
        break;
      }
    }

    // Also detect top/bottom/right borders
    let borderTop = 0;
    for (let row = 0; row < Math.min(8, height); row++) {
      let blackCount = 0;
      const sampleStep = Math.max(1, Math.floor(width / 100));
      let samples = 0;
      for (let col = borderLeft; col < width; col += sampleStep) {
        samples++;
        if (isBitBlack(col, row)) blackCount++;
      }
      if (samples > 0 && blackCount / samples > 0.9) {
        borderTop = row + 1;
      } else {
        break;
      }
    }

    let borderRight = 0;
    for (let col = width - 1; col >= width - 8 && col > borderLeft; col--) {
      let blackCount = 0;
      const sampleStep = Math.max(1, Math.floor(height / 100));
      let samples = 0;
      for (let row = borderTop; row < height; row += sampleStep) {
        samples++;
        if (isBitBlack(col, row)) blackCount++;
      }
      if (samples > 0 && blackCount / samples > 0.9) {
        borderRight++;
      } else {
        break;
      }
    }

    let borderBottom = 0;
    for (let row = height - 1; row >= height - 8 && row > borderTop; row--) {
      let blackCount = 0;
      const sampleStep = Math.max(1, Math.floor(width / 100));
      let samples = 0;
      for (let col = borderLeft; col < width - borderRight; col += sampleStep) {
        samples++;
        if (isBitBlack(col, row)) blackCount++;
      }
      if (samples > 0 && blackCount / samples > 0.9) {
        borderBottom++;
      } else {
        break;
      }
    }

    // Render content area only (skip detected borders)
    const contentW = width - borderLeft - borderRight;
    const contentH = height - borderTop - borderBottom;
    if (contentW <= 0 || contentH <= 0) return null;

    // Recreate canvases at cropped size
    tmp.width = contentW;
    tmp.height = contentH;
    const croppedImgData = tctx.createImageData(contentW, contentH);
    const cpx = croppedImgData.data;
    cpx.fill(255); // white background

    for (let y = 0; y < contentH; y++) {
      for (let x = 0; x < contentW; x++) {
        const srcX = x + borderLeft;
        const srcY = y + borderTop;
        if (isBitBlack(srcX, srcY)) {
          const idx = (y * contentW + x) * 4;
          cpx[idx] = 0; cpx[idx + 1] = 0; cpx[idx + 2] = 0;
        }
      }
    }

    tctx.putImageData(croppedImgData, 0, 0);

    // Rescale output canvas for cropped content
    const cropScale = contentW > maxW ? maxW / contentW : 1;
    const crw = Math.round(contentW * cropScale);
    const crh = Math.max(40, Math.round(contentH * cropScale));
    canvas.width = crw;
    canvas.height = crh;
    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, crw, crh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, crw, crh);
    return canvas.toDataURL('image/png');
  }

  // 8bpp path: render the full image without border cropping
  tctx.putImageData(imgData, 0, 0);
  ctx.fillStyle = '#FFF';
  ctx.fillRect(0, 0, rw, rh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, rw, rh);
  return canvas.toDataURL('image/png');
}

/**
 * Renders a labeled placeholder canvas at the given dimensions and returns
 * it as a PNG data URL. Used for color (24bpp) IM images that use IBM's
 * proprietary tile-based encoding (compression code 0x0D, FE9C tile markers)
 * which we cannot decode. The placeholder keeps the page layout correct.
 */
function renderColorImagePlaceholder(width: number, height: number): string | null {
  if (typeof document === 'undefined') return null;
  if (width <= 0 || height <= 0) return null;

  // Render at native pixel dimensions (capped to keep canvas reasonable)
  const w = Math.min(Math.max(width, 40), 2048);
  const h = Math.min(Math.max(height, 40), 2048);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Subtle filled background
  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, w, h);

  // Dashed border so it's clearly a placeholder
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 80));
  ctx.setLineDash([Math.max(4, w / 40), Math.max(3, w / 60)]);
  ctx.strokeRect(
    ctx.lineWidth / 2,
    ctx.lineWidth / 2,
    w - ctx.lineWidth,
    h - ctx.lineWidth,
  );
  ctx.setLineDash([]);

  // Centered label — sized relative to image so it stays readable
  const fontSize = Math.max(10, Math.round(Math.min(w / 12, h / 6)));
  ctx.fillStyle = '#6b7280';
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Color Image', w / 2, h / 2 - fontSize * 0.6);

  // Dimension subtitle
  const subSize = Math.max(8, Math.round(fontSize * 0.7));
  ctx.font = `${subSize}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(`${width} × ${height}`, w / 2, h / 2 + fontSize * 0.6);

  return canvas.toDataURL('image/png');
}

/**
 * Builds a JPEG data URL from IOCA tile-compressed 24bpp image data.
 * The IOCA format stores JPEG arithmetic-coded scan data in FE9C tiles
 * without standard JPEG headers. This function wraps the data with
 * SOF9 (arithmetic) JPEG headers so the browser can decode it.
 *
 * NOTE: Currently unused — the synthetic JPEG approach does not work
 * because browsers do not support arithmetic-coded JPEG. Kept for reference.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildIOCAJpegDataUrl(image: IMImage): string | null {
  const { width, height, data } = image;

  // Extract scan data: strip FE9C tile headers and tile-index bytes
  const rawScan: number[] = [];
  let pos = 0;
  while (pos < data.length) {
    if (pos + 3 < data.length && data[pos] === 0xFE && data[pos + 1] === 0x9C) {
      const tileLen = (data[pos + 2] << 8) | data[pos + 3];
      // Skip FE9C header (4 bytes) + tile header (5 bytes: tileIdx + 4 unknown)
      const start = pos + 4 + 5;
      const end = pos + 4 + tileLen;
      for (let i = start; i < end && i < data.length; i++) rawScan.push(data[i]);
      pos = end;
    } else {
      pos++;
    }
  }

  if (rawScan.length === 0) return null;

  // Build JPEG with arithmetic coding headers
  const parts: number[] = [];
  const w16 = (v: number) => { parts.push((v >> 8) & 0xFF, v & 0xFF); };

  // SOI
  parts.push(0xFF, 0xD8);

  // DQT — table 0 (luminance, high quality ≈ all 1s)
  parts.push(0xFF, 0xDB); w16(67); parts.push(0x00);
  for (let i = 0; i < 64; i++) parts.push(i < 32 ? 1 : 2);

  // DQT — table 1 (chrominance)
  parts.push(0xFF, 0xDB); w16(67); parts.push(0x01);
  for (let i = 0; i < 64; i++) parts.push(i < 32 ? 1 : 2);

  // SOF9 — arithmetic coding, sequential DCT
  parts.push(0xFF, 0xC9); w16(17);
  parts.push(8); // precision
  w16(height); w16(width);
  parts.push(3); // 3 components
  parts.push(1, 0x11, 0); // Y: id=1, sampling=1×1, qtable=0
  parts.push(2, 0x11, 1); // Cb: id=2, sampling=1×1, qtable=1
  parts.push(3, 0x11, 1); // Cr: id=3, sampling=1×1, qtable=1

  // DAC — Define Arithmetic Coding conditioning
  parts.push(0xFF, 0xCC); w16(10);
  parts.push(0x00, 0x00); // DC table 0
  parts.push(0x01, 0x00); // DC table 1
  parts.push(0x10, 0x05); // AC table 0
  parts.push(0x11, 0x05); // AC table 1

  // SOS — Start of Scan
  parts.push(0xFF, 0xDA); w16(12);
  parts.push(3); // 3 components
  parts.push(1, 0x00); // Y: DC=0, AC=0
  parts.push(2, 0x11); // Cb: DC=1, AC=1
  parts.push(3, 0x11); // Cr: DC=1, AC=1
  parts.push(0, 63, 0); // spectral selection

  // Append scan data
  for (let i = 0; i < rawScan.length; i++) parts.push(rawScan[i]);

  // EOI
  parts.push(0xFF, 0xD9);

  // Convert to base64 data URL
  const bytes = new Uint8Array(parts);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:image/jpeg;base64,' + btoa(binary);
}

function toHex(view: DataView, offset: number): string {
  return view.getUint8(offset + 3).toString(16).toUpperCase().padStart(2, '0') +
    view.getUint8(offset + 4).toString(16).toUpperCase().padStart(2, '0') +
    view.getUint8(offset + 5).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Decompress Modified Huffman (CCITT G3 1D) encoded data.
 * AFP IM Image format: no EOL markers, pure MH coding row by row.
 */
function decompressMH(compressed: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const output = new Uint8Array(height * bytesPerRow);
  output.fill(0xFF); // default white

  // Bit reader
  let bytePos = 0;
  let bitPos = 0;

  function getBit(): number {
    if (bytePos >= compressed.length) return 0;
    const bit = (compressed[bytePos] >> (7 - bitPos)) & 1;
    bitPos++;
    if (bitPos >= 8) { bitPos = 0; bytePos++; }
    return bit;
  }

  function getCode(isWhite: boolean, depth: number = 0): number {
    if (depth > 5 || bytePos >= compressed.length) return 0;

    let code = 0;
    let bits = 0;
    const termTable = isWhite ? W_TERMS : B_TERMS;
    const makeupTable = isWhite ? W_MAKEUPS : B_MAKEUPS;
    const maxBits = isWhite ? 12 : 13;

    while (bits < maxBits && bytePos < compressed.length) {
      code = (code << 1) | getBit();
      bits++;

      const key = (bits << 16) | code;
      if (termTable.has(key)) return termTable.get(key)!;
      if (makeupTable.has(key)) {
        return makeupTable.get(key)! + getCode(isWhite, depth + 1);
      }
    }

    return 0;
  }

  // Safety: limit total operations to prevent browser freeze
  let ops = 0;
  const maxOps = width * height * 2;

  for (let y = 0; y < height && ops < maxOps; y++) {
    let x = 0;
    let isWhite = true;

    while (x < width && bytePos < compressed.length && ops < maxOps) {
      ops++;
      const runLen = getCode(isWhite);
      if (runLen <= 0 && !isWhite) break; // stuck
      if (runLen > width - x) break; // overflow

      if (!isWhite && runLen > 0) {
        for (let i = 0; i < runLen && x + i < width; i++) {
          const px = x + i;
          const bi = y * bytesPerRow + (px >> 3);
          output[bi] &= ~(1 << (7 - (px & 7)));
        }
      }

      x += runLen;
      isWhite = !isWhite;
    }
  }

  return output;
}

// Huffman tables: Map<(bits << 16) | code, runLength>
const W_TERMS = new Map<number, number>();
const B_TERMS = new Map<number, number>();
const W_MAKEUPS = new Map<number, number>();
const B_MAKEUPS = new Map<number, number>();

(function initTables() {
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
    [0b01101000, 8, 36], [0b01101001, 8, 37], [0b01100010, 8, 38], [0b01100011, 8, 39],
    [0b01100110, 8, 40], [0b01100111, 8, 41], [0b01101100, 8, 42], [0b01101101, 8, 43],
    [0b01101010, 8, 44], [0b01101011, 8, 45], [0b01010010, 8, 46], [0b01010011, 8, 47],
    [0b01010100, 8, 48], [0b01010101, 8, 49], [0b00100100, 8, 50], [0b00100101, 8, 51],
    [0b01011000, 8, 52], [0b01011001, 8, 53], [0b01011010, 8, 54], [0b01011011, 8, 55],
    [0b01001010, 8, 56], [0b01001011, 8, 57], [0b00110010, 8, 58], [0b00110011, 8, 59],
    [0b00110100, 8, 60], [0b00110101, 8, 61], [0b00110110, 8, 62], [0b00110111, 8, 63],
  ];
  for (const [code, bits, run] of wt) W_TERMS.set((bits << 16) | code, run);

  // Black terminating codes
  const bt: [number, number, number][] = [
    [0b0000110111, 10, 0], [0b010, 3, 1], [0b11, 2, 2], [0b10, 2, 3],
    [0b011, 3, 4], [0b0011, 4, 5], [0b0010, 4, 6], [0b00011, 5, 7],
    [0b000101, 6, 8], [0b000100, 6, 9], [0b0000100, 7, 10], [0b0000101, 7, 11],
    [0b0000111, 7, 12], [0b00000100, 8, 13], [0b00000111, 8, 14], [0b00011000, 8, 15],
    [0b0000010111, 10, 16], [0b0000011000, 10, 17], [0b0000001000, 10, 18],
    [0b00001100111, 11, 19], [0b00001101000, 11, 20], [0b00001101100, 11, 21],
    [0b00000110111, 11, 22], [0b00000101000, 11, 23], [0b00000010111, 11, 24],
    [0b00000011000, 11, 25], [0b000011001010, 12, 26], [0b000011001011, 12, 27],
    [0b000011001100, 12, 28], [0b000011001101, 12, 29], [0b000001101000, 12, 30],
    [0b000001101001, 12, 31], [0b000001101010, 12, 32], [0b000001101011, 12, 33],
    [0b000011010010, 12, 34], [0b000011010011, 12, 35], [0b000011010100, 12, 36],
    [0b000011010101, 12, 37], [0b000011010110, 12, 38], [0b000011010111, 12, 39],
    [0b000001101100, 12, 40], [0b000001101101, 12, 41], [0b000011011010, 12, 42],
    [0b000011011011, 12, 43], [0b000001010100, 12, 44], [0b000001010101, 12, 45],
    [0b000001010110, 12, 46], [0b000001010111, 12, 47], [0b000001100100, 12, 48],
    [0b000001100101, 12, 49], [0b000001010010, 12, 50], [0b000001010011, 12, 51],
    [0b000000100100, 12, 52], [0b000000110111, 12, 53], [0b000000111000, 12, 54],
    [0b000000100111, 12, 55], [0b000000101000, 12, 56], [0b000001011000, 12, 57],
    [0b000001011001, 12, 58], [0b000000101011, 12, 59], [0b000000101100, 12, 60],
    [0b000001011010, 12, 61], [0b000001100110, 12, 62], [0b000001100111, 12, 63],
  ];
  for (const [code, bits, run] of bt) B_TERMS.set((bits << 16) | code, run);

  // White makeup codes (runs 64-1728)
  const wm: [number, number, number][] = [
    [0b11011, 5, 64], [0b10010, 5, 128], [0b010111, 6, 192], [0b0110111, 7, 256],
    [0b00110110, 8, 320], [0b00110111, 8, 384], [0b01100100, 8, 448], [0b01100101, 8, 512],
    [0b01101000, 8, 576], [0b01100111, 8, 640], [0b011001100, 9, 704], [0b011001101, 9, 768],
    [0b011010010, 9, 832], [0b011010011, 9, 896], [0b011010100, 9, 960], [0b011010101, 9, 1024],
    [0b011010110, 9, 1088], [0b011010111, 9, 1152], [0b011011000, 9, 1216], [0b011011001, 9, 1280],
    [0b011011010, 9, 1344], [0b011011011, 9, 1408], [0b010011000, 9, 1472], [0b010011001, 9, 1536],
    [0b010011010, 9, 1600], [0b011000, 6, 1664], [0b010011011, 9, 1728],
  ];
  for (const [code, bits, run] of wm) W_MAKEUPS.set((bits << 16) | code, run);

  // Black makeup codes (runs 64-1728)
  const bm: [number, number, number][] = [
    [0b0000001111, 10, 64], [0b000011001000, 12, 128], [0b000011001001, 12, 192],
    [0b000001011011, 12, 256], [0b000000110011, 12, 320], [0b000000110100, 12, 384],
    [0b000000110101, 12, 448], [0b0000001101100, 13, 512], [0b0000001101101, 13, 576],
    [0b0000001001010, 13, 640], [0b0000001001011, 13, 704], [0b0000001001100, 13, 768],
    [0b0000001001101, 13, 832], [0b0000001110010, 13, 896], [0b0000001110011, 13, 960],
    [0b0000001110100, 13, 1024], [0b0000001110101, 13, 1088], [0b0000001110110, 13, 1152],
    [0b0000001110111, 13, 1216], [0b0000001010010, 13, 1280], [0b0000001010011, 13, 1344],
    [0b0000001010100, 13, 1408], [0b0000001010101, 13, 1472], [0b0000001011010, 13, 1536],
    [0b0000001011011, 13, 1600], [0b0000001100100, 13, 1664], [0b0000001100101, 13, 1728],
  ];
  for (const [code, bits, run] of bm) B_MAKEUPS.set((bits << 16) | code, run);
})();

function extractName(data: Uint8Array): string {
  let n = '';
  for (let i = 0; i < Math.min(data.length, 8); i++) {
    const b = data[i];
    if (b >= 0xC1 && b <= 0xC9) n += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) n += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) n += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0xF0 && b <= 0xF9) n += String.fromCharCode(48 + b - 0xF0);
    else if (b === 0x40) n += ' ';
    else n += String.fromCharCode(b);
  }
  return n.trim();
}
