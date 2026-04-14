/**
 * PTOCA (Presentation Text Object Content Architecture) parser.
 *
 * Parses raw PTX structured-field data bytes into a PTOCATextObject containing
 * positioned TextRun entries ready for rendering.
 *
 * Reference: AFPC-0009-04 — Presentation Text Object Content Architecture.
 *
 * Control sequences always begin with 0x2B D3 (chained) or have a function
 * type byte following the 0x2B escape.  In practice, the first byte after the
 * escape is the control-sequence class/type, and the next byte is the length.
 * This implementation handles the most commonly encountered control sequences
 * and falls back gracefully on unknown ones.
 */

import type {
  AFPColor,
  FontMappingTable,
  Orientation,
  PTOCATextObject,
  TextRun,
} from '@/lib/afp/types';
import { ebcdicToUnicode } from '@/lib/ebcdic/transcoder';

// ---------------------------------------------------------------------------
// Control-sequence function types (second byte after 0x2B escape)
// ---------------------------------------------------------------------------

const CS_SCFL = 0x10; // Set Coded Font Local
const CS_SEC  = 0x80; // Set Extended Color (variant)
const CS_AMI  = 0xC0; // Absolute Move Inline
const CS_SVI  = 0xC4; // Set Variable Space Increment (unused in cursor, but parsed)
const CS_RMI  = 0xC8; // Relative Move Inline
const CS_SBI  = 0xD0; // Set Baseline Increment
const CS_AMB  = 0xD2; // Absolute Move Baseline
const CS_RMB  = 0xD4; // Relative Move Baseline
const CS_BLN  = 0xD8; // Begin Line
const CS_TRN  = 0xDA; // Transparent Data
const CS_DBR  = 0xE4; // Draw Baseline Rule
const CS_DIR  = 0xE6; // Draw Inline Rule
const CS_RPS  = 0xEE; // Repeat String
const CS_STO  = 0xF6; // Set Text Orientation
const CS_NOP  = 0xF8; // No Operation

// ---------------------------------------------------------------------------
// Internal cursor state
// ---------------------------------------------------------------------------

interface CursorState {
  inlinePos: number;        // X in L-units
  baselinePos: number;      // Y in L-units
  baselineIncrement: number;
  variableSpaceIncrement: number;
  fontId: number;
  color: AFPColor;
  orientation: Orientation;
}

function defaultCursor(): CursorState {
  return {
    inlinePos: 0,
    baselinePos: 0,
    baselineIncrement: 240,   // 1/6 inch default
    variableSpaceIncrement: 0,
    fontId: 0,
    color: { r: 0, g: 0, b: 0, a: 255 },
    orientation: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a big-endian unsigned 16-bit value. */
function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

/** Read a big-endian signed 16-bit value. */
function readS16(data: Uint8Array, offset: number): number {
  const u = (data[offset] << 8) | data[offset + 1];
  return u >= 0x8000 ? u - 0x10000 : u;
}

/** Clamp orientation to one of the four valid values. */
function normalizeOrientation(raw: number): Orientation {
  const deg = ((raw % 360) + 360) % 360;
  if (deg < 45) return 0;
  if (deg < 135) return 90;
  if (deg < 225) return 180;
  if (deg < 315) return 270;
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse PTOCA control sequences from raw PTX data bytes.
 *
 * @param data  The DATA portion of a PTX (Presentation Text Data, D3EE6B)
 *              structured field — i.e. the bytes *after* the structured-field
 *              header.
 * @returns     A PTOCATextObject containing positioned TextRun entries.
 */
/**
 * Detects if PTOCA data uses UTF-16BE encoding inside 0xDB (TRN) control sequences.
 * Checks the first DB CS found: if its content has alternating 0x00 + printable-ASCII
 * byte pairs, it's UTF-16BE. Otherwise it's EBCDIC.
 */
function isUnicodeFormat(data: Uint8Array): boolean {
  if (data.length < 20) return false;

  // Find the first 0xDB control sequence in the chained CS data
  let i = (data[0] === 0x2B && data[1] === 0xD3) ? 2 : 0;

  while (i < data.length) {
    const csLen = data[i];
    if (csLen < 2 || i + csLen > data.length) { i++; continue; }
    const csType = data[i + 1];

    if (csType === 0xDB && csLen > 6) {
      // Found a DB (TRN) CS — check if its content is UTF-16BE
      const params = data.slice(i + 2, i + csLen);
      // UTF-16BE: even bytes are 0x00, odd bytes are printable ASCII
      // e.g. 00 4A 00 6F 00 68 00 6E = "John"
      let utf16Pairs = 0;
      let totalPairs = 0;
      for (let j = 0; j + 1 < params.length && totalPairs < 20; j += 2) {
        totalPairs++;
        if (params[j] === 0x00 && params[j + 1] >= 0x20 && params[j + 1] < 0x7F) {
          utf16Pairs++;
        }
      }
      return totalPairs >= 3 && utf16Pairs / totalPairs > 0.5;
    }

    i += csLen;
  }

  return false;
}

/**
 * Parses PTOCA data encoded as chained control sequences with UTF-16BE text.
 *
 * After the 2BD3 unchained prefix, control sequences follow as:
 *   [LENGTH:1] [TYPE:1] [PARAMS:LENGTH-2]
 *
 * Key types:
 * - 0xC7 (len=4): Set X position — params = 2-byte BE L-units
 * - 0xD3 (len=4): Set Y position — params = 2-byte BE L-units
 * - 0xDB (variable): Transparent data — UTF-16BE text
 * - 0x81 (len=15): Set coded font local
 * - 0xF1 (len=3): Style/weight change
 * - 0xE5/0xE7 (len=7): Line/area definition
 * - 0xF7 (len=6): Set text orientation
 */
function parseUnicodePTOCA(data: Uint8Array): PTOCATextObject {
  const runs: TextRun[] = [];
  const black: AFPColor = { r: 0, g: 0, b: 0, a: 255 };

  let curX = 0;
  let curBold = false;
  let curUnderline = false;
  let curY = 0;
  let curFontSize = 10;
  let curColor: AFPColor = { ...black };

  // Start after 2BD3 prefix if present
  let i = (data[0] === 0x2B && data[1] === 0xD3) ? 2 : 0;

  while (i < data.length) {
    const csLen = data[i];
    if (csLen < 2 || i + csLen > data.length) {
      i++;
      continue;
    }

    const csType = data[i + 1];

    switch (csType) {
      case 0xC7: // Set X position (inline)
        if (csLen >= 4) curX = (data[i + 2] << 8) | data[i + 3];
        break;

      case 0xD3: // Set Y position (baseline)
        if (csLen >= 4) curY = (data[i + 2] << 8) | data[i + 3];
        break;

      case 0xDB: { // Transparent data — UTF-16BE text
        const textData = data.slice(i + 2, i + csLen);
        if (textData.length >= 2) {
          let text = '';
          for (let j = 0; j + 1 < textData.length; j += 2) {
            const cp = (textData[j] << 8) | textData[j + 1];
            if (cp >= 0x20) text += String.fromCharCode(cp);
          }
          if (text.length > 0) {
            runs.push({
              x: curX, y: curY, text,
              fontId: 0, color: { ...curColor },
              orientation: 0, fontSize: curFontSize,
              bold: curBold, underline: curUnderline,
            });
          }
        }
        break;
      }

      case 0xF1: // Style change
        if (csLen >= 3) {
          const style = data[i + 2];
          curBold = false;
          curUnderline = false;
          if (style === 1) {
            curFontSize = 10; curBold = true; curColor = { ...black };
          } else if (style === 2) {
            curFontSize = 24; curColor = { r: 79, g: 182, b: 224, a: 255 };
          } else if (style === 3) {
            curFontSize = 10; curColor = { ...black };
          } else if (style === 4) {
            curFontSize = 9; curColor = { ...black };
          } else if (style === 5) {
            curFontSize = 9; curBold = true; curColor = { ...black };
          } else if (style === 6) {
            curFontSize = 10; curUnderline = true; curColor = { r: 79, g: 182, b: 224, a: 255 };
          } else {
            curFontSize = 10; curColor = { ...black };
          }
        }
        break;

      case 0x80: // SEC — color
        if (csLen >= 5) {
          curColor = { r: data[i + 2], g: data[i + 3], b: data[i + 4], a: 255 };
        }
        break;

      case 0x81: // SCFL — font
      case 0xE5: // Line definition
      case 0xE7: // Area definition
      case 0xF7: // STO2
      case 0xF6: // STO
      case 0xD0: // SBI
      case 0xC4: // SVI
      case 0xC0: // AMI
        break;

      default:
        break;
    }

    i += csLen;
  }

  return { runs, bounds: computeBounds(runs) };
}

/**
 * Parses PTOCA data in unchained format (2BD3 prefix) with EBCDIC text in 0xDB CSs.
 * Each chained CS: [LENGTH:1] [TYPE:1] [PARAMS:LENGTH-2]
 * 0xDB = Transparent data (EBCDIC text)
 * 0xC7 = Set inline position (X), 0xD3 = Set baseline position (Y)
 * 0xC1 = AMI (X position), 0xD1 = AMB (Y position)
 */
function parseChainedEbcdicPTOCA(
  data: Uint8Array,
  fontMap?: FontMappingTable,
): PTOCATextObject {
  const runs: TextRun[] = [];
  const black: AFPColor = { r: 0, g: 0, b: 0, a: 255 };

  let curX = 0;
  let curY = 0;
  const _lastRenderedY = -1; // reserved for future wrap detection
  let baselineIncrement = 0;
  let curColor: AFPColor = { ...black };
  let curFontSize = 10;
  let curBold = false;
  let curFontId = 0;
  let curOrientation: Orientation = 0;

  let i = (data[0] === 0x2B && data[1] === 0xD3) ? 2 : 0;

  while (i < data.length) {
    const csLen = data[i];
    if (csLen < 2 || i + csLen > data.length) { i++; continue; }

    const csType = data[i + 1];

    switch (csType) {
      case 0xC7: // STC — Set inline position (absolute X)
      case 0xC0: // AMI — Absolute Move Inline
        if (csLen >= 4) curX = (data[i + 2] << 8) | data[i + 3];
        break;

      case 0xC1: // AMI variant — could be absolute X
        if (csLen >= 4) curX = (data[i + 2] << 8) | data[i + 3];
        break;

      case 0xD2: // AMB — Absolute Move Baseline (always absolute Y)
        if (csLen >= 4) curY = (data[i + 2] << 8) | data[i + 3];
        break;

      case 0xD3: // Could be absolute Y position OR baseline increment
      case 0xD1: // Same ambiguity
        if (csLen >= 4) {
          const val = (data[i + 2] << 8) | data[i + 3];
          // Heuristic: values > 100 are absolute Y positions (e.g. 354, 397, 527)
          // Values <= 100 are baseline increments (e.g. 36, 40, 44)
          if (val > 100) {
            curY = val; // absolute position
          } else {
            baselineIncrement = val; // set increment for D9/D8
          }
        }
        break;

      case 0xD9: // New line — advance Y by baseline increment
        curY += baselineIncrement;
        break;

      case 0xD8: // BLN — Begin Line
        curY += baselineIncrement;
        break;

      case 0xDB: { // TRN — Transparent data (EBCDIC text)
        const textData = data.slice(i + 2, i + csLen);
        if (textData.length > 0) {
          const decoded = ebcdicToUnicode(textData);
          const clean = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
          if (clean.length > 0) {
            if (curOrientation === 270 || curOrientation === 90) {
              // Rotated text: merge with previous rotated run if possible
              const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
              if (lastRun && lastRun.orientation === curOrientation) {
                // Append to previous rotated run (same line)
                lastRun.text += clean;
              } else {
                // New rotated text run — position at left margin, always regular weight
                const rotX = curOrientation === 270 ? 60 : curX;
                runs.push({
                  x: rotX, y: curY, text: clean,
                  fontId: curFontId, color: { ...curColor },
                  orientation: curOrientation, fontSize: 6,
                  bold: false, // tracking codes are always regular weight
                });
              }
            } else {
              runs.push({
                x: curX, y: curY, text: clean,
                fontId: curFontId, color: { ...curColor },
                orientation: curOrientation, fontSize: curFontSize,
                bold: curBold,
              });
            }
            // Advance X by estimated text width
            const charWidthFactor = curBold ? 0.48 : 0.42;
            curX += Math.round(clean.length * (curFontSize / 72) * 300 * charWidthFactor);
          }
        }
        break;
      }

      case 0xC5: // Set Coded Font — font resource index (not a direct size)
        break;

      case 0xF1: // SCFL — Set Coded Font Local
        // The byte after F1 is a font local ID that maps via MCF (D3AB8A)
        // to a coded font name and character set (e.g. "C0FL20A0"). The
        // character set name suffix encodes the weight: a 4th-character
        // 'M' (Medium) means bold, 'L' (Light) means regular. When the
        // page parser supplies an MCF lookup table we use it; otherwise
        // we default to regular weight.
        if (csLen >= 3) {
          curFontId = data[i + 2];
          curFontSize = 10;
          const mapping = fontMap?.get(curFontId);
          curBold = mapping?.bold ?? false;
        }
        break;

      case 0x80: // SEC — color
        if (csLen >= 5) {
          curColor = { r: data[i + 2], g: data[i + 3], b: data[i + 4], a: 255 };
        }
        break;

      case 0xF6: // STO — Set Text Orientation
      case 0xF7: // STO2 — Set Text Orientation (variant)
        if (csLen >= 4) {
          const inlineOr = (data[i + 2] << 8) | data[i + 3];
          const deg = Math.round((inlineOr / 0xB400) * 360) % 360;
          curOrientation = (deg >= 315 || deg < 45 ? 0 : deg < 135 ? 90 : deg < 225 ? 180 : 270) as Orientation;
          // Rotated text (tracking codes etc.) is typically small and regular weight
          if (curOrientation !== 0) {
            curBold = false;
            curFontSize = 6;
          }
        }
        break;

      default:
        break;
    }

    i += csLen;
  }

  return { runs, bounds: computeBounds(runs) };
}

export function parsePTOCA(
  data: Uint8Array,
  fontMap?: FontMappingTable,
): PTOCATextObject {
  // Detect Unicode/ASCII encoded PTOCA (non-EBCDIC AFP files)
  if (isUnicodeFormat(data)) {
    return parseUnicodePTOCA(data);
  }

  // If data starts with 2BD3 (unchained prefix), parse as chained CSs with EBCDIC
  if (data.length > 4 && data[0] === 0x2B && data[1] === 0xD3) {
    return parseChainedEbcdicPTOCA(data, fontMap);
  }

  const runs: TextRun[] = [];
  const cursor = defaultCursor();

  // Accumulators for the current text segment (bytes that are NOT control
  // sequences). When we encounter a control sequence (or reach the end of
  // data) we flush the accumulated text into a TextRun.
  let textBytes: number[] = [];

  /** Flush any accumulated text bytes into a TextRun. */
  function flushText(): void {
    if (textBytes.length === 0) return;
    const decoded = ebcdicToUnicode(new Uint8Array(textBytes));
    // Filter out control characters that snuck through
    const clean = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    if (clean.length > 0) {
      runs.push({
        x: cursor.inlinePos,
        y: cursor.baselinePos,
        text: clean,
        fontId: cursor.fontId,
        color: { ...cursor.color },
        orientation: cursor.orientation,
        fontSize: 12, // default; real size requires FOCA font metric lookup
      });
      // Advance inline position by approximate character count × an assumed
      // character width.  A real implementation would use FOCA metrics, but
      // for now we use a reasonable default of 120 L-units (~1/12 inch) per
      // character, which is roughly 10-pitch.
      cursor.inlinePos += clean.length * 120;
    }
    textBytes = [];
  }

  let offset = 0;
  while (offset < data.length) {
    const byte = data[offset];

    // -----------------------------------------------------------------------
    // Control sequence escape: 0x2B followed by function-type byte
    // -----------------------------------------------------------------------
    if (byte === 0x2B && offset + 1 < data.length) {
      // Flush any text collected so far before processing the control sequence
      flushText();

      const csType = data[offset + 1];

      // All PTOCA chained control sequences have the form:
      //   0x2B <type> <length> <params ...>
      // The length byte includes itself but NOT the 0x2B or type bytes.
      // Unchained form: 0x2BD3 <length:2> <type> <params>
      // We handle both forms.

      // Check for unchained prefix 0x2BD3
      if (csType === 0xD3 && offset + 4 < data.length) {
        // Unchained control sequence
        const csLen = readU16(data, offset + 2);
        const funcType = data[offset + 4];
        const paramStart = offset + 5;
        const paramLen = csLen - 3; // csLen includes len(2)+type(1), params = rest
        processControlSequence(
          funcType,
          data,
          paramStart,
          Math.max(0, paramLen),
          cursor,
          runs,
        );
        offset += 2 + csLen; // skip 0x2B D3 + csLen bytes
        continue;
      }

      // Chained control sequence: 0x2B <type> <length> <params ...>
      if (offset + 2 < data.length) {
        const csLen = data[offset + 2]; // length byte (includes itself)
        if (csLen === 0) {
          // Malformed — skip the two bytes and carry on
          offset += 2;
          continue;
        }
        const paramStart = offset + 3;
        const paramLen = csLen - 1; // csLen includes the length byte itself
        processControlSequence(
          csType,
          data,
          paramStart,
          Math.max(0, paramLen),
          cursor,
          runs,
        );
        offset += 2 + csLen; // 0x2B + type + csLen bytes
        continue;
      }

      // Not enough data for a full control sequence — skip escape
      offset += 2;
      continue;
    }

    // -----------------------------------------------------------------------
    // Printable data byte — collect for later flush
    // -----------------------------------------------------------------------
    textBytes.push(byte);
    offset++;
  }

  // Flush any remaining text
  flushText();

  // Compute bounding rectangle
  const bounds = computeBounds(runs);

  return { runs, bounds };
}

// ---------------------------------------------------------------------------
// Control-sequence dispatcher
// ---------------------------------------------------------------------------

function processControlSequence(
  funcType: number,
  data: Uint8Array,
  paramStart: number,
  paramLen: number,
  cursor: CursorState,
  runs: TextRun[],
): void {
  switch (funcType) {
    // --- Movement --------------------------------------------------------

    case CS_AMI: {
      // Absolute Move Inline — 2 byte unsigned value
      if (paramLen >= 2) {
        cursor.inlinePos = readU16(data, paramStart);
      }
      break;
    }

    case CS_RMI: {
      // Relative Move Inline — 2 byte signed value
      if (paramLen >= 2) {
        cursor.inlinePos += readS16(data, paramStart);
      }
      break;
    }

    case CS_AMB: {
      // Absolute Move Baseline — 2 byte unsigned value
      if (paramLen >= 2) {
        cursor.baselinePos = readU16(data, paramStart);
      }
      break;
    }

    case CS_RMB: {
      // Relative Move Baseline — 2 byte signed value
      if (paramLen >= 2) {
        cursor.baselinePos += readS16(data, paramStart);
      }
      break;
    }

    // --- State ------------------------------------------------------------

    case CS_STO: {
      // Set Text Orientation — two 2-byte values (inline & baseline angles
      // in units of 1/2 degree).  We only use the inline orientation.
      if (paramLen >= 4) {
        const inlineDeg = readU16(data, paramStart);
        // Convert from 1/2-degree units to degrees
        const degrees = Math.round(inlineDeg / 2);
        cursor.orientation = normalizeOrientation(degrees);
      }
      break;
    }

    case CS_SBI: {
      // Set Baseline Increment — 2 byte unsigned
      if (paramLen >= 2) {
        cursor.baselineIncrement = readU16(data, paramStart);
      }
      break;
    }

    case CS_SVI: {
      // Set Variable Space Increment — 2 byte unsigned
      if (paramLen >= 2) {
        cursor.variableSpaceIncrement = readU16(data, paramStart);
      }
      break;
    }

    case CS_SEC: {
      // Set Extended Color
      // Byte 0: reserved
      // Byte 1: color space (0x01=RGB, 0x04=CMYK, …)
      // Bytes 2..n: color values
      if (paramLen >= 5) {
        const colorSpace = data[paramStart + 1];
        if (colorSpace === 0x01 && paramLen >= 5) {
          // RGB
          cursor.color = {
            r: data[paramStart + 2],
            g: data[paramStart + 3],
            b: data[paramStart + 4],
            a: 255,
          };
        } else if (colorSpace === 0x06 || colorSpace === 0x04) {
          // Grayscale or simple — map first byte to grayscale
          const v = data[paramStart + 2];
          cursor.color = { r: v, g: v, b: v, a: 255 };
        }
        // else: keep existing color
      } else if (paramLen >= 1) {
        // Short-form: single-byte indexed color
        const idx = data[paramStart];
        cursor.color = indexedColor(idx);
      }
      break;
    }

    case CS_SCFL: {
      // Set Coded Font Local — 1 byte font ID
      if (paramLen >= 1) {
        cursor.fontId = data[paramStart];
      }
      break;
    }

    // --- Text data -------------------------------------------------------

    case CS_TRN: {
      // Transparent Data — the remaining paramLen bytes are literal text
      if (paramLen > 0) {
        const textSlice = data.slice(paramStart, paramStart + paramLen);
        const decoded = ebcdicToUnicode(textSlice);
        const clean = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
        if (clean.length > 0) {
          runs.push({
            x: cursor.inlinePos,
            y: cursor.baselinePos,
            text: clean,
            fontId: cursor.fontId,
            color: { ...cursor.color },
            orientation: cursor.orientation,
            fontSize: 12,
          });
          cursor.inlinePos += clean.length * 120;
        }
      }
      break;
    }

    // --- Line operations -------------------------------------------------

    case CS_BLN: {
      // Begin Line — advance baseline by current increment, reset inline
      cursor.baselinePos += cursor.baselineIncrement;
      cursor.inlinePos = 0;
      break;
    }

    case CS_DBR: {
      // Draw Baseline Rule — draws a horizontal line
      // Params: 2-byte length, 2-byte width (thickness)
      // We record it as a thin text run with a special marker
      if (paramLen >= 4) {
        const ruleLength = readU16(data, paramStart);
        const ruleWidth = readU16(data, paramStart + 2);
        runs.push({
          x: cursor.inlinePos,
          y: cursor.baselinePos,
          text: '',
          fontId: cursor.fontId,
          color: { ...cursor.color },
          orientation: cursor.orientation,
          fontSize: 0,
        });
        // Store rule dimensions in a way the renderer can detect
        const ruleRun = runs[runs.length - 1];
        (ruleRun as TextRun & { ruleWidth?: number; ruleLength?: number }).ruleLength = ruleLength;
        (ruleRun as TextRun & { ruleWidth?: number; ruleLength?: number }).ruleWidth = ruleWidth;
        cursor.inlinePos += ruleLength;
      }
      break;
    }

    case CS_DIR: {
      // Draw Inline Rule — draws a vertical line
      if (paramLen >= 4) {
        const ruleLength = readU16(data, paramStart);
        const ruleWidth = readU16(data, paramStart + 2);
        runs.push({
          x: cursor.inlinePos,
          y: cursor.baselinePos,
          text: '',
          fontId: cursor.fontId,
          color: { ...cursor.color },
          orientation: cursor.orientation,
          fontSize: 0,
        });
        const ruleRun = runs[runs.length - 1];
        (ruleRun as TextRun & { ruleWidth?: number; ruleLength?: number; vertical?: boolean }).ruleLength = ruleLength;
        (ruleRun as TextRun & { ruleWidth?: number; ruleLength?: number; vertical?: boolean }).ruleWidth = ruleWidth;
        (ruleRun as TextRun & { ruleWidth?: number; ruleLength?: number; vertical?: boolean }).vertical = true;
      }
      break;
    }

    case CS_RPS: {
      // Repeat String — repeat the next byte(s) a given number of times
      // Byte 0-1: repeat count, remaining bytes: the string to repeat
      if (paramLen >= 3) {
        const count = readU16(data, paramStart);
        const strBytes = data.slice(paramStart + 2, paramStart + paramLen);
        const oneChar = ebcdicToUnicode(strBytes);
        const clean = oneChar.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
        if (clean.length > 0) {
          const repeated = clean.repeat(Math.min(count, 10000)); // safety cap
          runs.push({
            x: cursor.inlinePos,
            y: cursor.baselinePos,
            text: repeated,
            fontId: cursor.fontId,
            color: { ...cursor.color },
            orientation: cursor.orientation,
            fontSize: 12,
          });
          cursor.inlinePos += repeated.length * 120;
        }
      }
      break;
    }

    // --- No-op / unknown -------------------------------------------------

    case CS_NOP:
      // No operation — intentionally do nothing
      break;

    default:
      // Unknown control sequence — skip silently (already advanced past it)
      break;
  }
}

// ---------------------------------------------------------------------------
// Indexed colour palette (AFP standard colours)
// ---------------------------------------------------------------------------

function indexedColor(idx: number): AFPColor {
  switch (idx) {
    case 0x00: return { r: 0,   g: 0,   b: 0,   a: 255 }; // default (black on device)
    case 0x01: return { r: 0,   g: 0,   b: 255, a: 255 }; // blue
    case 0x02: return { r: 255, g: 0,   b: 0,   a: 255 }; // red
    case 0x03: return { r: 255, g: 0,   b: 255, a: 255 }; // magenta / pink
    case 0x04: return { r: 0,   g: 255, b: 0,   a: 255 }; // green
    case 0x05: return { r: 0,   g: 255, b: 255, a: 255 }; // cyan / turquoise
    case 0x06: return { r: 255, g: 255, b: 0,   a: 255 }; // yellow
    case 0x07: return { r: 255, g: 255, b: 255, a: 255 }; // white
    case 0x08: return { r: 0,   g: 0,   b: 0,   a: 255 }; // black
    case 0x10: return { r: 139, g: 69,  b: 19,  a: 255 }; // brown
    default:   return { r: 0,   g: 0,   b: 0,   a: 255 }; // fallback black
  }
}

// ---------------------------------------------------------------------------
// Bounding-box computation
// ---------------------------------------------------------------------------

function computeBounds(runs: TextRun[]): { x: number; y: number; width: number; height: number } {
  if (runs.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const run of runs) {
    const runWidth = run.text.length * 120; // approximate
    const runHeight = 240; // approximate line height in L-units
    if (run.x < minX) minX = run.x;
    if (run.y < minY) minY = run.y;
    if (run.x + runWidth > maxX) maxX = run.x + runWidth;
    if (run.y + runHeight > maxY) maxY = run.y + runHeight;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
