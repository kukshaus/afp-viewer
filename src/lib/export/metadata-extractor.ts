/**
 * AFP Metadata Extractor
 *
 * Scans an entire AFP file to extract TLE (Tagged Logical Element) and NOP
 * (No Operation / comment) metadata from all locations — document-level,
 * between pages, within named groups, etc.
 */

// ---------------------------------------------------------------------------
// EBCDIC decoding (local copy — avoids importing browser-only transcoder)
// ---------------------------------------------------------------------------

function decodeEbcdic(data: DataView, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < data.byteLength; i++) {
    const b = data.getUint8(i);
    if (b === 0x00) continue;
    if (b === 0x40) s += ' ';
    else if (b >= 0xC1 && b <= 0xC9) s += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) s += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) s += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0x81 && b <= 0x89) s += String.fromCharCode(97 + b - 0x81);
    else if (b >= 0x91 && b <= 0x99) s += String.fromCharCode(106 + b - 0x91);
    else if (b >= 0xA2 && b <= 0xA9) s += String.fromCharCode(115 + b - 0xA2);
    else if (b >= 0xF0 && b <= 0xF9) s += String.fromCharCode(48 + b - 0xF0);
    else if (b === 0x6D) s += '_';
    else if (b === 0x7D) s += "'";
    else if (b === 0x4B) s += '.';
    else if (b === 0x6B) s += ',';
    else if (b === 0x60) s += '-';
    else if (b === 0x61) s += '/';
    else if (b === 0x7B) s += '#';
    else if (b === 0x7C) s += '@';
    else if (b === 0x4D) s += '(';
    else if (b === 0x5D) s += ')';
    else if (b === 0x7E) s += '=';
    else if (b === 0x5C) s += '*';
    else if (b === 0x50) s += '&';
    else if (b === 0x7A) s += ':';
    else if (b === 0x5E) s += ';';
    else if (b === 0x4F) s += '!';
    else if (b >= 0x20 && b < 0x7F) s += String.fromCharCode(b);
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TLEEntry {
  key: string;
  value: string;
  /** Location context: which page or section this TLE was found near */
  context: string;
  /** Byte offset in the file */
  offset: number;
}

export interface NOPEntry {
  value: string;
  context: string;
  offset: number;
}

export interface DocumentMetadata {
  documentName: string;
  totalPages: number;
  fileSize: number;
  tles: TLEEntry[];
  nops: NOPEntry[];
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/**
 * Scans the entire AFP file and extracts all TLE and NOP metadata entries.
 */
export function extractAllMetadata(
  fileData: ArrayBuffer,
  totalPages: number,
): DocumentMetadata {
  const view = new DataView(fileData);
  const tles: TLEEntry[] = [];
  const nops: NOPEntry[] = [];
  let documentName = '';
  let currentPage = 0;
  let offset = 0;

  while (offset < fileData.byteLength - 9) {
    if (view.getUint8(offset) !== 0x5A) {
      offset++;
      continue;
    }

    const len = view.getUint16(offset + 1, false);
    if (len < 6 || len > 32766) {
      offset++;
      continue;
    }

    const t3 = view.getUint8(offset + 3);
    const t4 = view.getUint8(offset + 4);
    const t5 = view.getUint8(offset + 5);
    const dl = len - 8;

    // BDT — document name
    if (t3 === 0xD3 && t4 === 0xA8 && t5 === 0xA8 && dl >= 8 && !documentName) {
      documentName = decodeEbcdic(view, offset + 9, 8);
    }

    // BPG — track page number
    if (t3 === 0xD3 && t4 === 0xA8 && t5 === 0xAD) {
      currentPage++;
    }

    // TLE (D3A090)
    if (t3 === 0xD3 && t4 === 0xA0 && t5 === 0x90 && dl > 4) {
      let tp = offset + 9;
      const tEnd = offset + 9 + dl;
      let key = '';
      let value = '';

      while (tp + 2 < tEnd) {
        const tLen = view.getUint8(tp);
        const tId = view.getUint8(tp + 1);
        if (tLen < 2 || tp + tLen > tEnd) break;

        if (tId === 0x02 && tLen > 4) {
          key = decodeEbcdic(view, tp + 4, tLen - 4);
        }
        if (tId === 0x36 && tLen > 4) {
          value = decodeEbcdic(view, tp + 4, tLen - 4);
        }
        tp += tLen;
      }

      if (key || value) {
        const context =
          currentPage === 0
            ? 'document-level'
            : `page-${currentPage}`;
        tles.push({ key, value, context, offset });
      }
    }

    // NOP (D3EEEE)
    if (t3 === 0xD3 && t4 === 0xEE && t5 === 0xEE && dl > 0) {
      const text = decodeEbcdic(view, offset + 9, Math.min(dl, 256));
      if (text.length > 0) {
        const context =
          currentPage === 0
            ? 'document-level'
            : `page-${currentPage}`;
        nops.push({ value: text, context, offset });
      }
    }

    const next = offset + 1 + len;
    if (next <= offset) break;
    offset = next;
  }

  return {
    documentName,
    totalPages,
    fileSize: fileData.byteLength,
    tles,
    nops,
  };
}
