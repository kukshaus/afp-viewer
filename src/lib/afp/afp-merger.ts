/**
 * AFP Document Merger — client-side.
 *
 * Two modes:
 *   1. **Concatenate** (default) — raw byte append, each file keeps its own
 *      BDT/EDT envelope and resources. This is the industry-standard approach
 *      used by IBM AFP Utilities and Ricoh InfoPrint. Always valid, always fast.
 *
 *   2. **Single document** — extracts pages from every file and wraps them in
 *      file 1's document envelope (BDT + resources … pages … EDT). Use this
 *      when the downstream consumer expects exactly one BDT/EDT pair.
 *      Resources from files 2..N are injected into the preamble so pages that
 *      reference them still work.
 */

export interface MergeFileEntry {
  name: string;
  data: ArrayBuffer;
  pageCount: number;
}

export interface MergeResult {
  blob: Blob;
  totalPages: number;
  totalFiles: number;
  totalBytes: number;
}

// ── Quick page count ────────────────────────────────────────────────────────

/**
 * Single-pass page counter. Counts BPG records (standard pages).
 * If none found, falls back to BDT count (multi-document files where
 * each document = one logical page).
 */
export function quickPageCount(data: ArrayBuffer): number {
  const view = new DataView(data);
  let bpg = 0;
  let bdt = 0;
  let offset = 0;
  const size = data.byteLength;

  while (offset < size) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 5 > size) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }
    if (view.getUint8(offset + 3) === 0xD3) {
      const b4 = view.getUint8(offset + 4);
      const b5 = view.getUint8(offset + 5);
      if (b4 === 0xA8 && b5 === 0xAD) bpg++;      // BPG
      else if (b4 === 0xA8 && b5 === 0xA8) bdt++;  // BDT
    }
    const next = offset + 1 + length;
    if (next <= offset) break;
    offset = next;
  }
  return bpg > 0 ? bpg : bdt;
}

// ── Mode 1: Concatenate ─────────────────────────────────────────────────────

/**
 * Concatenate multiple AFP files into a single print stream.
 * Each file retains its own BDT/EDT document envelope and resources.
 * This produces a multi-document AFP file — 100 % valid per spec.
 */
export function concatAfp(files: MergeFileEntry[]): MergeResult {
  if (files.length === 0) throw new Error('No files to merge');

  const parts: ArrayBuffer[] = [];
  let totalPages = 0;
  let totalBytes = 0;
  for (const f of files) {
    parts.push(f.data);
    totalPages += f.pageCount;
    totalBytes += f.data.byteLength;
  }

  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    totalPages,
    totalFiles: files.length,
    totalBytes,
  };
}

// ── Mode 2: Single document ─────────────────────────────────────────────────

interface PageRange { offset: number; endOffset: number }

/** Scan a file for page boundaries and preamble/postamble extents. */
function scanFileStructure(data: ArrayBuffer): {
  preambleEnd: number;
  postambleStart: number;
  pages: PageRange[];
} {
  const view = new DataView(data);
  const pages: PageRange[] = [];
  let preambleEnd = 0;
  let postambleStart = data.byteLength;
  let currentBpg = -1;
  let offset = 0;
  const size = data.byteLength;

  while (offset < size) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 5 > size) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }

    const b4 = view.getUint8(offset + 4);
    const b5 = view.getUint8(offset + 5);

    // BPG: D3 A8 AD
    if (view.getUint8(offset + 3) === 0xD3 && b4 === 0xA8 && b5 === 0xAD) {
      if (pages.length === 0 && currentBpg === -1) preambleEnd = offset;
      currentBpg = offset;
    }

    // EPG: D3 A9 AD
    if (view.getUint8(offset + 3) === 0xD3 && b4 === 0xA9 && b5 === 0xAD && currentBpg >= 0) {
      const end = offset + 1 + length;
      pages.push({ offset: currentBpg, endOffset: end });
      postambleStart = end;
      currentBpg = -1;
    }

    const next = offset + 1 + length;
    if (next <= offset) break;
    offset = next;
  }

  return { preambleEnd, postambleStart, pages };
}

/**
 * Extract resource bytes from a preamble (everything between BDT and BPG).
 * Skips the BDT record itself so only resource definitions remain.
 */
function extractResourceBytes(data: ArrayBuffer, preambleEnd: number): Uint8Array[] {
  const view = new DataView(data);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let skippedBdt = false;

  while (offset < preambleEnd) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 5 > preambleEnd) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }

    const recordEnd = offset + 1 + length;

    // Skip BDT (D3 A8 A8) and EDT (D3 A9 A8) — we use file 1's envelope
    const b3 = view.getUint8(offset + 3);
    const b4 = view.getUint8(offset + 4);
    const b5 = view.getUint8(offset + 5);
    const isBdt = b3 === 0xD3 && b4 === 0xA8 && b5 === 0xA8;

    if (isBdt) {
      skippedBdt = true;
      offset = recordEnd > offset ? recordEnd : offset + 1;
      continue;
    }

    // Only include records after BDT (resources, medium maps, etc.)
    if (skippedBdt) {
      chunks.push(new Uint8Array(data, offset, recordEnd - offset));
    }

    offset = recordEnd > offset ? recordEnd : offset + 1;
  }

  return chunks;
}

/**
 * Merge multiple AFP files into a single document (one BDT/EDT).
 * File 1's document envelope and resources are used as the base.
 * Resources from files 2..N are injected into the preamble.
 */
export function mergeAfpSingleDocument(files: MergeFileEntry[]): MergeResult {
  if (files.length === 0) throw new Error('No files to merge');
  if (files.length === 1) {
    return {
      blob: new Blob([files[0].data], { type: 'application/octet-stream' }),
      totalPages: files[0].pageCount,
      totalFiles: 1,
      totalBytes: files[0].data.byteLength,
    };
  }

  // Scan all files
  const structures = files.map((f) => scanFileStructure(f.data));

  // File 1: full preamble (BDT + resources)
  const preamble = files[0].data.slice(0, structures[0].preambleEnd);

  // Files 2..N: extract resource bytes (without BDT)
  const extraResources: Uint8Array[] = [];
  for (let i = 1; i < files.length; i++) {
    const chunks = extractResourceBytes(files[i].data, structures[i].preambleEnd);
    extraResources.push(...chunks);
  }

  // All pages from all files
  const pageSlices: ArrayBuffer[] = [];
  let totalPages = 0;
  for (let i = 0; i < files.length; i++) {
    for (const pg of structures[i].pages) {
      pageSlices.push(files[i].data.slice(pg.offset, pg.endOffset));
      totalPages++;
    }
  }

  // Postamble from file 1
  const postamble = files[0].data.slice(structures[0].postambleStart);

  // Assemble: preamble + extra resources + pages + postamble
  const blobParts: BlobPart[] = [
    preamble,
    ...extraResources.map((r) => r.buffer as ArrayBuffer),
    ...pageSlices,
    postamble,
  ];
  let totalBytes = preamble.byteLength + postamble.byteLength;
  for (const r of extraResources) totalBytes += r.byteLength;
  for (const p of pageSlices) totalBytes += p.byteLength;

  return {
    blob: new Blob(blobParts, { type: 'application/octet-stream' }),
    totalPages,
    totalFiles: files.length,
    totalBytes,
  };
}
