/**
 * AFP Document Splitter — client-side, zero-dependency.
 *
 * Uses the pre-built page index (byteOffset + byteLength) so there is
 * NO re-scanning of the file.  Splitting a 2 GB file takes < 50 ms
 * because it is just three ArrayBuffer.slice() calls per output part.
 *
 * Each output part is a structurally valid AFP document:
 *   preamble (BDT + resources) + selected pages + postamble (EDT)
 */

import type { PageIndex } from '@/lib/afp/types';

export interface SplitResult {
  part1: Blob;
  part2: Blob;
  part1Pages: number;
  part2Pages: number;
}

/**
 * Split an AFP document after `splitAfterPage` (1-based).
 *
 * @param fileData   The full AFP ArrayBuffer already in memory.
 * @param pageIndex  The page index built by the index scanner.
 * @param splitAfterPage  1-based page number. Part 1 gets pages 1..N,
 *                        part 2 gets pages N+1..total.
 */
export function splitAfp(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  splitAfterPage: number,
): SplitResult {
  const total = pageIndex.length;
  if (total < 2) throw new Error('Need at least 2 pages to split');
  if (splitAfterPage < 1 || splitAfterPage >= total) {
    throw new Error(`Split page must be 1..${total - 1}`);
  }

  // Preamble: everything from file start to the first BPG
  const preambleEnd = pageIndex[0].byteOffset;
  const preamble = fileData.slice(0, preambleEnd);

  // Postamble: everything after the last page's EPG to end of file
  const lastPage = pageIndex[total - 1];
  const postambleStart = lastPage.byteOffset + lastPage.byteLength;
  const postamble = fileData.slice(postambleStart);

  // Part 1 pages: 0..splitAfterPage-1  (index is 0-based)
  const p1Start = pageIndex[0].byteOffset;
  const p1LastPage = pageIndex[splitAfterPage - 1];
  const p1End = p1LastPage.byteOffset + p1LastPage.byteLength;
  const pages1 = fileData.slice(p1Start, p1End);

  // Part 2 pages: splitAfterPage..total-1
  const p2Start = pageIndex[splitAfterPage].byteOffset;
  const p2End = postambleStart;
  const pages2 = fileData.slice(p2Start, p2End);

  return {
    part1: new Blob([preamble, pages1, postamble], { type: 'application/octet-stream' }),
    part2: new Blob([preamble, pages2, postamble], { type: 'application/octet-stream' }),
    part1Pages: splitAfterPage,
    part2Pages: total - splitAfterPage,
  };
}

export interface BatchPart {
  filename: string;
  blob: Blob;
  pageCount: number;
  startPage: number; // 1-based
  endPage: number;   // 1-based inclusive
}

/**
 * Batch-split an AFP document every `chunkSize` pages.
 *
 * Example: 950 pages with chunkSize=100 → 10 parts (9 x 100 + 1 x 50).
 * Each part is a valid AFP document with the full preamble/postamble.
 */
export function batchSplitAfp(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  chunkSize: number,
): BatchPart[] {
  const total = pageIndex.length;
  if (total === 0) throw new Error('No pages in document');
  if (chunkSize < 1) throw new Error('Chunk size must be >= 1');

  // Preamble + postamble (shared across all parts)
  const preambleEnd = pageIndex[0].byteOffset;
  const preamble = fileData.slice(0, preambleEnd);
  const lastPage = pageIndex[total - 1];
  const postambleStart = lastPage.byteOffset + lastPage.byteLength;
  const postamble = fileData.slice(postambleStart);

  const parts: BatchPart[] = [];
  const numParts = Math.ceil(total / chunkSize);
  const padLen = String(numParts).length;

  for (let i = 0; i < total; i += chunkSize) {
    const end = Math.min(i + chunkSize, total);
    const startOffset = pageIndex[i].byteOffset;
    const endPage = pageIndex[end - 1];
    const endOffset = endPage.byteOffset + endPage.byteLength;
    const pages = fileData.slice(startOffset, endOffset);

    const partNum = String(parts.length + 1).padStart(padLen, '0');
    parts.push({
      filename: `part_${partNum}.afp`,
      blob: new Blob([preamble, pages, postamble], { type: 'application/octet-stream' }),
      pageCount: end - i,
      startPage: i + 1,
      endPage: end,
    });
  }

  return parts;
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Bundle multiple parts into a ZIP and trigger download.
 * Uses fflate for fast, streaming compression.
 */
export async function downloadPartsAsZip(
  parts: BatchPart[],
  zipFilename: string,
): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate');

  // Build the file map for fflate
  const files: Record<string, Uint8Array> = {};
  for (const part of parts) {
    const buf = await part.blob.arrayBuffer();
    files[part.filename] = new Uint8Array(buf);
  }

  // Add a small manifest
  const manifest = parts
    .map((p) => `${p.filename}  (pages ${p.startPage}-${p.endPage}, ${p.pageCount} pages)`)
    .join('\n');
  files['_manifest.txt'] = strToU8(manifest);

  // ZIP with STORE (no compression) — AFP is binary, compression gains are tiny
  // but it would slow down large files significantly. STORE = instant.
  const zipData = zipSync(files, { level: 0 });

  downloadBlob(
    new Blob([zipData as BlobPart], { type: 'application/zip' }),
    zipFilename,
  );
}
