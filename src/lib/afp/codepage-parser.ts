/**
 * AFP Code Page Index (CPI) Parser
 *
 * Extracts character mappings from embedded AFP code page resources.
 * The CPI structured field (D3AC89) contains byte→Unicode mappings
 * that override the default EBCDIC code page.
 */

import { iterateStructuredFields } from '@/lib/afp/parser';

const TYPE_BCP = 'D3A889'; // Begin Code Page
const TYPE_ECP = 'D3A989'; // End Code Page
const TYPE_CPD = 'D3A689'; // Code Page Descriptor
const TYPE_CPI = 'D3AC89'; // Code Page Index
const TYPE_BOC = 'D3A8CE'; // Begin Object Container
const TYPE_EOC = 'D3A9CE'; // End Object Container

/** A parsed code page: maps EBCDIC byte values to Unicode code points. */
export interface ParsedCodePage {
  name: string;
  mapping: number[]; // 256 entries: byte → Unicode code point
}

/**
 * Scan the AFP file buffer for embedded code page resources and build
 * byte→Unicode mapping tables from the CPI (Code Page Index) data.
 *
 * @returns Map from code page name to its character mapping.
 */
export function parseEmbeddedCodePages(buffer: ArrayBuffer): Map<string, ParsedCodePage> {
  const codePages = new Map<string, ParsedCodePage>();

  let currentCPName = '';
  let inCodePage = false;
  let currentMapping: number[] = [];

  for (const field of iterateStructuredFields(buffer)) {
    switch (field.typeId) {
      case TYPE_BCP: {
        // Begin Code Page — extract name from first 8 bytes
        inCodePage = true;
        currentMapping = new Array(256).fill(0xFFFD); // default to replacement char
        if (field.data.length >= 8) {
          currentCPName = extractName(field.data, 0, 8);
        }
        break;
      }

      case TYPE_CPD: {
        // Code Page Descriptor — contains font name info
        // We already have the name from BCP, but CPD may have more detail
        if (inCodePage && field.data.length >= 30) {
          const fontName = extractName(field.data, 0, Math.min(field.data.length, 32));
          if (fontName && !currentCPName) currentCPName = fontName;
        }
        break;
      }

      case TYPE_CPI: {
        // Code Page Index — the actual byte→Unicode mapping!
        // Format: repeating entries, each containing:
        //   - Unicode code point (2 bytes BE)
        //   - EBCDIC byte value (1 byte) or graphic character ID
        //   - Additional flags
        if (inCodePage && field.data.length > 0) {
          parseCPIData(field.data, currentMapping);
        }
        break;
      }

      case TYPE_ECP: {
        // End Code Page — finalize the mapping
        if (inCodePage && currentCPName) {
          // Fill in standard ASCII/EBCDIC for unmapped positions
          fillDefaults(currentMapping);
          codePages.set(currentCPName, {
            name: currentCPName,
            mapping: currentMapping,
          });
        }
        inCodePage = false;
        currentCPName = '';
        currentMapping = [];
        break;
      }

      // Stop scanning once we hit document content (optimization)
      case 'D3A8A8': // BDT
        if (codePages.size > 0) return codePages;
        break;
    }
  }

  return codePages;
}

/**
 * Parse CPI structured field data to extract byte→Unicode mappings.
 *
 * The CPI contains repeating groups, each with:
 * - Byte 0-1: Unicode code point (big-endian)
 * - Byte 2: Code page byte value (the EBCDIC byte this maps from)
 * - Bytes 3+: flags, metrics
 *
 * Some CPI formats use a different layout — we try both.
 */
function parseCPIData(data: Uint8Array, mapping: number[]): void {
  if (data.length < 2) return;

  // Try to detect the CPI format
  // Format 1: Fixed 8-byte entries (Unicode(2) + GCGID(8) or similar)
  // Format 2: Variable entries with a header byte indicating entry length

  // Check first byte — if it looks like a reasonable entry length
  const entryLen = data[0];

  if (entryLen >= 4 && entryLen <= 16 && data.length >= entryLen * 2) {
    // Variable-length entry format
    let offset = 0;
    while (offset + entryLen <= data.length) {
      const len = data[offset];
      if (len < 4 || offset + len > data.length) break;

      // Extract Unicode code point and byte value
      // Common layout: [len] [flags] [codepoint_hi] [codepoint_lo] [byte_value] ...
      const codePoint = (data[offset + 2] << 8) | data[offset + 3];
      const byteValue = len >= 5 ? data[offset + 4] : 0;

      if (byteValue > 0 && byteValue < 256 && codePoint > 0 && codePoint < 0xFFFF) {
        mapping[byteValue] = codePoint;
      }

      offset += len;
    }
  } else {
    // Try fixed 10-byte entry format (common in AFP code pages)
    // Each entry: [GCGID(8)] [CodePoint(2)] or [CodePoint(2)][GCGID(8)]
    const entrySize = 10;
    if (data.length % entrySize === 0 || data.length % 8 === 0) {
      // Try 10-byte entries
      for (let i = 0; i + entrySize <= data.length; i += entrySize) {
        // Check if first 2 bytes could be Unicode
        const cp1 = (data[i] << 8) | data[i + 1];
        // Check if bytes 8-9 could be Unicode
        const _cp2 = (i + 10 <= data.length) ? (data[i + 8] << 8) | data[i + 9] : 0;

        // Use whichever looks more like a valid Unicode code point
        if (cp1 >= 0x0020 && cp1 <= 0xFFEF) {
          // First 2 bytes are Unicode, byte index might be derived from position
          const byteIdx = Math.floor(i / entrySize) + 0x40; // start from 0x40 (space region)
          if (byteIdx < 256) {
            mapping[byteIdx] = cp1;
          }
        }
      }
    }
  }
}

/** Fill unmapped positions with standard CP500 defaults. */
function fillDefaults(mapping: number[]): void {
  // Standard positions that should always be mapped
  const defaults: Record<number, number> = {
    0x40: 0x0020, // space
    0x4B: 0x002E, // .
    0x4D: 0x0028, // (
    0x4E: 0x002B, // +
    0x50: 0x0026, // &
    0x5D: 0x0029, // )
    0x5E: 0x003B, // ;
    0x60: 0x002D, // -
    0x61: 0x002F, // /
    0x6B: 0x002C, // ,
    0x6C: 0x0025, // %
    0x6D: 0x005F, // _
    0x6E: 0x003E, // >
    0x6F: 0x003F, // ?
    0x7A: 0x003A, // :
    0x7B: 0x0023, // #
    0x7D: 0x0027, // '
    0x7E: 0x003D, // =
    0x7F: 0x0022, // "
    0xB5: 0x0040, // @
  };

  // Letters A-Z
  for (let i = 0; i < 9; i++) { defaults[0xC1 + i] = 0x41 + i; } // A-I
  for (let i = 0; i < 9; i++) { defaults[0xD1 + i] = 0x4A + i; } // J-R
  for (let i = 0; i < 8; i++) { defaults[0xE2 + i] = 0x53 + i; } // S-Z
  // Letters a-z
  for (let i = 0; i < 9; i++) { defaults[0x81 + i] = 0x61 + i; } // a-i
  for (let i = 0; i < 9; i++) { defaults[0x91 + i] = 0x6A + i; } // j-r
  for (let i = 0; i < 8; i++) { defaults[0xA2 + i] = 0x73 + i; } // s-z
  // Digits 0-9
  for (let i = 0; i < 10; i++) { defaults[0xF0 + i] = 0x30 + i; }

  // German characters
  defaults[0xC0] = 0x00E4; // ä
  defaults[0xD0] = 0x00FC; // ü
  defaults[0xDC] = 0x00FC; // ü (also at this position in some files)
  defaults[0x43] = 0x00E4; // ä (CP037 position)
  defaults[0x59] = 0x00DF; // ß
  defaults[0xA1] = 0x00DF; // ß (CP500 position)

  for (const [byte, cp] of Object.entries(defaults)) {
    const b = Number(byte);
    if (mapping[b] === 0xFFFD) {
      mapping[b] = cp;
    }
  }
}

/** Extract a resource name from EBCDIC data. */
function extractName(data: Uint8Array, start: number, maxLen: number): string {
  let name = '';
  for (let i = start; i < start + maxLen && i < data.length; i++) {
    const b = data[i];
    if (b === 0x40) { name += ' '; continue; }
    if (b >= 0xC1 && b <= 0xC9) name += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) name += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) name += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0x81 && b <= 0x89) name += String.fromCharCode(97 + b - 0x81);
    else if (b >= 0x91 && b <= 0x99) name += String.fromCharCode(106 + b - 0x91);
    else if (b >= 0xA2 && b <= 0xA9) name += String.fromCharCode(115 + b - 0xA2);
    else if (b >= 0xF0 && b <= 0xF9) name += String.fromCharCode(48 + b - 0xF0);
    else if (b >= 0x20 && b < 0x7F) name += String.fromCharCode(b);
  }
  return name.trim();
}
