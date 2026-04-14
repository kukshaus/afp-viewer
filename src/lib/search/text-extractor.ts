/**
 * Fast Text-Only Extractor
 *
 * Extracts text content from AFP page bytes by scanning ONLY for text-related
 * structured fields (BPT, PTX, PTD). Skips images, graphics, barcodes, and all
 * other non-text fields entirely — typically 10-50x faster than full parsePage().
 *
 * Also extracts TLE (Tagged Logical Element) key-value pairs from page bytes.
 */

import { parsePTOCA } from '@/lib/ptoca/parser';

// Structured field type IDs for text
const SF_BPT     = 0xD3A87B; // Begin Presentation Text (standard)
const SF_EPT     = 0xD3A97B; // End Presentation Text
const SF_BPT_ALT = 0xD3A89B; // Begin Presentation Text (alternate)
const SF_EPT_ALT = 0xD3A99B; // End Presentation Text (alternate)
const SF_PTX     = 0xD3EE9B; // Presentation Text Data (alternate/common)
const SF_PTX_STD = 0xD3EE6B; // Presentation Text Data (standard)
const SF_TLE     = 0xD3A090; // Tagged Logical Element

// ---------------------------------------------------------------------------
// EBCDIC decode (minimal, for TLE extraction)
// ---------------------------------------------------------------------------

function ebcdicByte(b: number): string {
  if (b >= 0xC1 && b <= 0xC9) return String.fromCharCode(65 + b - 0xC1);
  if (b >= 0xD1 && b <= 0xD9) return String.fromCharCode(74 + b - 0xD1);
  if (b >= 0xE2 && b <= 0xE9) return String.fromCharCode(83 + b - 0xE2);
  if (b >= 0x81 && b <= 0x89) return String.fromCharCode(97 + b - 0x81);
  if (b >= 0x91 && b <= 0x99) return String.fromCharCode(106 + b - 0x91);
  if (b >= 0xA2 && b <= 0xA9) return String.fromCharCode(115 + b - 0xA2);
  if (b >= 0xF0 && b <= 0xF9) return String.fromCharCode(48 + b - 0xF0);
  if (b === 0x40) return ' ';
  if (b === 0x4B) return '.';
  if (b === 0x6B) return ',';
  if (b === 0x7D) return "'";
  if (b === 0x60) return '-';
  if (b === 0x61) return '/';
  if (b === 0x50) return '&';
  if (b === 0x6D) return '_';
  if (b === 0x7A) return ':';
  if (b === 0x5E) return ';';
  if (b === 0x4F) return '!';
  if (b === 0x7E) return '=';
  if (b === 0x5C) return '*';
  if (b === 0x7B) return '#';
  if (b === 0x7C) return '@';
  if (b === 0x4D) return '(';
  if (b === 0x5D) return ')';
  return '';
}

function ebcdicStr(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < data.length; i++) {
    s += ebcdicByte(data[i]);
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// Fast text extraction
// ---------------------------------------------------------------------------

export interface ExtractedPageData {
  pageNumber: number;
  text: string;
  tles: Array<{ key: string; value: string }>;
}

export interface FileTleEntry {
  key: string;
  value: string;
  /** Absolute byte offset of the TLE structured field in the file */
  offset: number;
}

/**
 * Extracts text and TLEs from a page's byte range using a fast scan.
 * Only looks at text-related structured fields — skips images/graphics/barcodes.
 */
export function extractPageData(
  fileData: ArrayBuffer,
  byteOffset: number,
  byteLength: number,
  pageNumber: number,
): ExtractedPageData {
  const view = new DataView(fileData);
  const end = Math.min(byteOffset + byteLength, fileData.byteLength);

  const textParts: string[] = [];
  const tles: Array<{ key: string; value: string }> = [];

  // Track whether we're inside a BPT..EPT block
  let inText = false;
  const ptxChunks: Uint8Array[] = [];

  let offset = byteOffset;

  while (offset < end - 8) {
    // Find magic byte
    if (view.getUint8(offset) !== 0x5A) {
      offset++;
      continue;
    }

    // Read length
    const len = view.getUint16(offset + 1, false);
    if (len < 6 || len > 32766) {
      offset++;
      continue;
    }

    const recordEnd = offset + 1 + len;
    if (recordEnd > end) break;

    // Read 3-byte type ID as a single 24-bit number for fast comparison
    const typeId =
      (view.getUint8(offset + 3) << 16) |
      (view.getUint8(offset + 4) << 8) |
      view.getUint8(offset + 5);

    const dataLen = len - 8;
    const dataStart = offset + 9;

    switch (typeId) {
      case SF_BPT:
      case SF_BPT_ALT:
        inText = true;
        ptxChunks.length = 0;
        break;

      case SF_EPT:
      case SF_EPT_ALT:
        // Flush accumulated PTX data
        if (ptxChunks.length > 0) {
          const totalLen = ptxChunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(totalLen);
          let pos = 0;
          for (const chunk of ptxChunks) {
            merged.set(chunk, pos);
            pos += chunk.length;
          }
          try {
            const parsed = parsePTOCA(merged);
            for (const run of parsed.runs) {
              if (run.text.trim()) {
                textParts.push(run.text);
              }
            }
          } catch {
            // Skip unparseable text
          }
          ptxChunks.length = 0;
        }
        inText = false;
        break;

      case SF_PTX:
      case SF_PTX_STD:
        if (inText && dataLen > 0 && dataStart + dataLen <= fileData.byteLength) {
          ptxChunks.push(new Uint8Array(fileData, dataStart, dataLen));
        }
        break;

      case SF_TLE:
        if (dataLen > 4 && dataStart + dataLen <= fileData.byteLength) {
          const tleData = new Uint8Array(fileData, dataStart, dataLen);
          let key = '';
          let value = '';
          let j = 0;
          while (j < tleData.length) {
            if (j + 2 > tleData.length) break;
            const tlen = tleData[j];
            if (tlen < 2 || j + tlen > tleData.length) break;
            const tid = tleData[j + 1];
            if (tid === 0x02 && tlen > 4) {
              key = ebcdicStr(tleData, j + 4, j + tlen);
            } else if (tid === 0x36 && tlen > 4) {
              value = ebcdicStr(tleData, j + 4, j + tlen);
            }
            j += tlen;
          }
          if (key) tles.push({ key, value });
        }
        break;

      // All other fields: skip entirely (images, graphics, barcodes, etc.)
    }

    offset = recordEnd;
  }

  // Handle unclosed text block
  if (ptxChunks.length > 0) {
    const totalLen = ptxChunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of ptxChunks) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    try {
      const parsed = parsePTOCA(merged);
      for (const run of parsed.runs) {
        if (run.text.trim()) {
          textParts.push(run.text);
        }
      }
    } catch {
      // Skip
    }
  }

  return {
    pageNumber,
    text: textParts.join(' '),
    tles,
  };
}

/**
 * Scans the ENTIRE AFP file for TLE structured fields.
 * Returns each TLE with its absolute byte offset, so callers can associate
 * each TLE with its containing or nearest page using the page index.
 *
 * This catches TLEs that exist OUTSIDE page byte ranges — e.g., TLEs at the
 * document, named-group, or print-file level which would otherwise be missed
 * by per-page extraction.
 */
export function extractAllTles(fileData: ArrayBuffer): FileTleEntry[] {
  const view = new DataView(fileData);
  const totalSize = fileData.byteLength;
  const tles: FileTleEntry[] = [];

  let offset = 0;
  while (offset < totalSize - 8) {
    if (view.getUint8(offset) !== 0x5A) {
      offset++;
      continue;
    }

    const len = view.getUint16(offset + 1, false);
    if (len < 6 || len > 32766) {
      offset++;
      continue;
    }

    const recordEnd = offset + 1 + len;
    if (recordEnd > totalSize) break;

    const typeId =
      (view.getUint8(offset + 3) << 16) |
      (view.getUint8(offset + 4) << 8) |
      view.getUint8(offset + 5);

    if (typeId === SF_TLE) {
      const dataLen = len - 8;
      const dataStart = offset + 9;
      if (dataLen > 4 && dataStart + dataLen <= totalSize) {
        const tleData = new Uint8Array(fileData, dataStart, dataLen);
        let key = '';
        let value = '';
        let j = 0;
        while (j < tleData.length) {
          if (j + 2 > tleData.length) break;
          const tlen = tleData[j];
          if (tlen < 2 || j + tlen > tleData.length) break;
          const tid = tleData[j + 1];
          if (tid === 0x02 && tlen > 4) {
            key = ebcdicStr(tleData, j + 4, j + tlen);
          } else if (tid === 0x36 && tlen > 4) {
            value = ebcdicStr(tleData, j + 4, j + tlen);
          }
          j += tlen;
        }
        if (key) {
          tles.push({ key, value, offset });
        }
      }
    }

    offset = recordEnd;
  }

  return tles;
}
