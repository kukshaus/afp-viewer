/**
 * Core AFP Structured Field Parser
 *
 * Reads the binary AFP stream record-by-record. Each structured field has the
 * format: [0x5A] [LENGTH:2B] [TYPE_ID:3B] [FLAGS:1B] [SEQ:2B] [DATA:variable]
 *
 * LENGTH is big-endian and counts bytes from the LENGTH field itself through the
 * end of the record (i.e. it does NOT include the leading 0x5A byte).
 */

import type { AFPStructuredField } from '@/lib/afp/types';
import { MAGIC_BYTE, SF_TYPES } from '@/lib/afp/constants';

// Minimum structured field size: 0x5A (1) + LENGTH (2) + TYPE_ID (3) + FLAGS (1) + SEQ (2) = 9 bytes
const MIN_SF_SIZE = 9;
// The fixed header portion counted inside LENGTH: TYPE_ID (3) + FLAGS (1) + SEQ (2) = 6
const HEADER_INSIDE_LENGTH = 6;
// Maximum reasonable structured field length (32 KB is the AFP spec limit)
const MAX_SF_LENGTH = 32766;

/**
 * Converts three type-ID bytes into a hex string like "D3A8AD".
 */
export function parseTypeId(byte1: number, byte2: number, byte3: number): string {
  return (
    byte1.toString(16).toUpperCase().padStart(2, '0') +
    byte2.toString(16).toUpperCase().padStart(2, '0') +
    byte3.toString(16).toUpperCase().padStart(2, '0')
  );
}

/**
 * Returns a human-readable name for a structured field type ID.
 * Falls back to "Unknown (<typeId>)" for unrecognised codes.
 */
export function getFieldName(typeId: string): string {
  const name = SF_TYPES[typeId];
  if (name) return name;

  // Built-in fallback table for the most critical field types so the parser
  // works even if constants is incomplete.
  const builtIn: Record<string, string> = {
    'D3A8A8': 'Begin Document (BDT)',
    'D3A9A8': 'End Document (EDT)',
    'D3A8AD': 'Begin Page (BPG)',
    'D3A9AD': 'End Page (EPG)',
    'D3A87B': 'Begin Presentation Text (BPT)',
    'D3A97B': 'End Presentation Text (EPT)',
    'D3EEEE': 'Presentation Text Descriptor (PTD)',
    'D3EE6B': 'Presentation Text Data (PTX)',
    'D3A8C5': 'Begin Image (BIM)',
    'D3A9C5': 'End Image (EIM)',
    'D3ACCE': 'Image Data Descriptor (IDD)',
    'D3EE7B': 'Image Data Element (IDE)',
    'D3A8C3': 'Begin Graphics (BGR)',
    'D3A9C3': 'End Graphics (EGR)',
    'D3EECC': 'Graphics Area Data (GAD)',
    'D3A8EB': 'Begin Bar Code (BBC)',
    'D3A9EB': 'End Bar Code (EBC)',
    'D3A6C3': 'Object Area Descriptor (OBD)',
    'D3AC6B': 'Object Area Position (OBP)',
    'D3ABCA': 'Begin Named Group (BNG)',
    'D3A9CA': 'End Named Group (ENG)',
    'D3A87E': 'Begin Font Resource Group (BFG)',
    'D3A8A7': 'Begin Object Area (BAG)',
    'D3A9A7': 'End Object Area (EAG)',
    'D3ABAF': 'Begin Resource (BRS)',
    'D3A9AF': 'End Resource (ERS)',
    'D3A6EE': 'Font Control (FNC)',
  };

  return builtIn[typeId] ?? `Unknown (${typeId})`;
}

/**
 * Validates that a structured field length value is reasonable and that the
 * record fits within the available data.
 *
 * @param length - The 2-byte LENGTH value read from the record (excludes 0x5A).
 * @param offset - Current offset of the LENGTH field in the buffer.
 * @param totalSize - Total size of the buffer / file.
 * @returns true if the length is plausible and fits in the buffer.
 */
export function validateLength(
  length: number,
  offset: number,
  totalSize: number,
): boolean {
  // LENGTH must be at least 8 (TYPE_ID:3 + FLAGS:1 + SEQ:2 + at least 0 data bytes = 6,
  // but the minimum value is really the header overhead = 6).
  // In practice 6 is the absolute minimum (an empty structured field with no data).
  if (length < HEADER_INSIDE_LENGTH) return false;
  if (length > MAX_SF_LENGTH) return false;
  // offset points to the LENGTH field (byte after 0x5A).
  // The full record from the LENGTH field onward occupies `length` bytes.
  if (offset + length > totalSize) return false;
  return true;
}

/**
 * Scans forward from `startOffset` to find the next 0x5A magic byte.
 * Used for error recovery when the current position does not contain a valid
 * structured field.
 *
 * @returns The offset of the next 0x5A byte, or -1 if none found.
 */
function scanForMagicByte(
  view: DataView,
  startOffset: number,
): number {
  const totalSize = view.byteLength;
  for (let i = startOffset; i < totalSize; i++) {
    if (view.getUint8(i) === MAGIC_BYTE) {
      return i;
    }
  }
  return -1;
}

/**
 * Attempts to read one AFP structured field from a DataView at the given offset.
 *
 * Binary layout:
 *   Offset 0   : 0x5A magic byte
 *   Offset 1-2 : LENGTH (big-endian, counts bytes 1..end, excludes 0x5A)
 *   Offset 3-5 : TYPE_ID (3 bytes)
 *   Offset 6   : FLAGS
 *   Offset 7-8 : SEQUENCE NUMBER
 *   Offset 9.. : DATA (LENGTH - 8 bytes)
 *
 * @param view   - DataView over the AFP data buffer.
 * @param offset - Byte offset at which to start reading.
 * @returns An object with the parsed field and the offset of the next record,
 *          or null if EOF / unrecoverable error.
 */
export function readStructuredField(
  view: DataView,
  offset: number,
): { field: AFPStructuredField; nextOffset: number } | null {
  const totalSize = view.byteLength;

  // Not enough room for even the magic byte.
  if (offset >= totalSize) return null;

  // ---- Locate the magic byte ----
  let pos = offset;
  if (view.getUint8(pos) !== MAGIC_BYTE) {
    // Current position is not a magic byte. This could be corrupt data or
    // carriage-control characters. Scan forward for the next 0x5A.
    const recovered = scanForMagicByte(view, pos + 1);
    if (recovered === -1) {
      // No more structured fields in the buffer.
      return null;
    }
    if (typeof console !== 'undefined') {
      console.warn(
        `AFP parser: expected 0x5A at offset ${pos}, found at ${recovered} ` +
          `(skipped ${recovered - pos} bytes of corrupt/unknown data)`,
      );
    }
    pos = recovered;
  }

  // ---- Need at least MIN_SF_SIZE bytes from pos ----
  if (pos + MIN_SF_SIZE > totalSize) return null;

  // ---- Read LENGTH (2 bytes, big-endian) ----
  const length = view.getUint16(pos + 1, false); // big-endian

  // ---- Validate length ----
  // `pos + 1` is where LENGTH sits; the full record from pos+1 onward is `length` bytes.
  if (!validateLength(length, pos + 1, totalSize)) {
    // Length looks wrong. Try to recover by scanning for the next 0x5A.
    if (typeof console !== 'undefined') {
      console.warn(
        `AFP parser: invalid LENGTH ${length} at offset ${pos}. Attempting resync.`,
      );
    }
    const recovered = scanForMagicByte(view, pos + 1);
    if (recovered === -1) return null;

    // Recurse once from the recovered position. Use a direct call rather than
    // mutual recursion to avoid infinite loops — if recovery also fails the
    // validateLength check will trigger `scanForMagicByte` again, but
    // eventually we will hit EOF.
    return readStructuredField(view, recovered);
  }

  // ---- Read TYPE_ID (3 bytes) ----
  const byte1 = view.getUint8(pos + 3);
  const byte2 = view.getUint8(pos + 4);
  const byte3 = view.getUint8(pos + 5);
  const typeId = parseTypeId(byte1, byte2, byte3);

  // ---- Read FLAGS (1 byte) ----
  const flags = view.getUint8(pos + 6);

  // ---- Read SEQUENCE NUMBER (2 bytes, big-endian) ----
  const sequenceNumber = view.getUint16(pos + 7, false);

  // ---- Extract DATA ----
  // Data length = LENGTH - (TYPE_ID:3 + FLAGS:1 + SEQ:2) = LENGTH - 6
  // But we must also account for the 2 bytes of the LENGTH field itself that
  // are included in `length`. Actually, per the AFP spec, LENGTH counts from
  // byte 1 (the first byte of LENGTH itself) through the end of the record.
  // So the DATA portion is: length - 2(LENGTH field) - 3(TYPE_ID) - 1(FLAGS) - 2(SEQ) = length - 8
  const dataLength = length - 8;
  let data: Uint8Array;

  if (dataLength > 0) {
    // The data starts at pos+9 (after 0x5A + LENGTH:2 + TYPE:3 + FLAGS:1 + SEQ:2)
    const dataStart = pos + 9;
    if (dataStart + dataLength > totalSize) {
      // Truncated record — take what we can.
      data = new Uint8Array(view.buffer, view.byteOffset + dataStart, totalSize - dataStart);
    } else {
      data = new Uint8Array(view.buffer, view.byteOffset + dataStart, dataLength);
    }
  } else {
    data = new Uint8Array(0);
  }

  // ---- Build field object ----
  const field: AFPStructuredField = {
    typeId,
    typeName: getFieldName(typeId),
    offset: pos,
    length,
    flags,
    sequenceNumber,
    data,
  };

  // Next record starts at: pos (0x5A) + 1 + length
  // Because LENGTH counts from the LENGTH field to end of record, and 0x5A is 1 byte before that.
  const nextOffset = pos + 1 + length;

  return { field, nextOffset };
}

/**
 * Iterates over all structured fields in a buffer. Yields each field lazily,
 * which is useful for streaming-style processing without building a full array.
 */
export function* iterateStructuredFields(
  data: ArrayBuffer,
  startOffset = 0,
): Generator<AFPStructuredField, void, undefined> {
  const view = new DataView(data);
  let offset = startOffset;

  while (offset < data.byteLength) {
    const result = readStructuredField(view, offset);
    if (result === null) break;
    yield result.field;
    offset = result.nextOffset;
  }
}

/**
 * Reads all structured fields from a buffer into an array.
 * For large buffers prefer `iterateStructuredFields` to avoid holding them all
 * in memory simultaneously.
 */
export function readAllStructuredFields(
  data: ArrayBuffer,
  startOffset = 0,
): AFPStructuredField[] {
  const fields: AFPStructuredField[] = [];
  for (const field of iterateStructuredFields(data, startOffset)) {
    fields.push(field);
  }
  return fields;
}
