/**
 * AFP Index Scanner — Pass 1
 *
 * Performs a streaming O(N) scan of an AFP file, reading only structured field
 * headers to build a lightweight PageIndexEntry[] without parsing page content.
 *
 * Two flavours:
 *   1. scanIndex()          — synchronous, operates on a complete ArrayBuffer.
 *   2. scanIndexStreaming()  — async, consumes a ReadableStream chunk by chunk,
 *                              handling structured fields that span boundaries.
 */

import type { PageIndexEntry } from '@/lib/afp/types';
import { MAGIC_BYTE } from '@/lib/afp/constants';
import { readStructuredField, parseTypeId } from '@/lib/afp/parser';

// ---- Type ID constants (hex strings) used for index scanning ----
const TYPE_BDT = 'D3A8A8'; // Begin Document
const TYPE_EDT = 'D3A9A8'; // End Document
const TYPE_BPG = 'D3A8AD'; // Begin Page
const TYPE_EPG = 'D3A9AD'; // End Page
const TYPE_BNG = 'D3ABCA'; // Begin Named Group
const TYPE_ENG = 'D3A9CA'; // End Named Group
const TYPE_BPT = 'D3A87B'; // Begin Presentation Text
const TYPE_BIM = 'D3A8C5'; // Begin Image
const TYPE_OBD = 'D3A6C3'; // Object Area Descriptor

// Progress emission interval
const PROGRESS_INTERVAL = 10000;

// Average bytes per page — used for rough estimates
const ESTIMATED_BYTES_PER_PAGE = 4096;

/**
 * Extracts a name string from the data portion of a BNG (Begin Named Group)
 * structured field. The name is typically stored as an 8-byte EBCDIC string at
 * offset 0 of the data payload, but for simplicity we treat it as ASCII /
 * Latin-1 (which covers the vast majority of production AFP named-group names).
 */
function extractNameFromBNG(data: Uint8Array): string | null {
  if (data.length === 0) return null;
  // The BNG data starts with a variable-length name (padded with 0x40 = EBCDIC space).
  // We read up to the first 8 bytes (or the data length, whichever is shorter).
  const nameLen = Math.min(data.length, 8);
  const bytes: number[] = [];
  for (let i = 0; i < nameLen; i++) {
    const b = data[i];
    // 0x40 is EBCDIC space — stop or convert to ASCII space
    if (b === 0x40) {
      // Treat as trailing padding — break
      break;
    }
    // Simple EBCDIC-to-ASCII for printable characters (letters, digits).
    // Full EBCDIC transcoding is deferred to the page parser; here we only
    // need a rough identifier.
    bytes.push(ebcdicToAscii(b));
  }
  if (bytes.length === 0) return null;
  return String.fromCharCode(...bytes);
}

/**
 * Minimal EBCDIC → ASCII conversion for the characters likely to appear in
 * resource/group names (letters A-Z, digits 0-9, and a few symbols).
 */
function ebcdicToAscii(b: number): number {
  // Uppercase letters
  if (b >= 0xC1 && b <= 0xC9) return b - 0xC1 + 0x41; // A-I
  if (b >= 0xD1 && b <= 0xD9) return b - 0xD1 + 0x4A; // J-R
  if (b >= 0xE2 && b <= 0xE9) return b - 0xE2 + 0x53; // S-Z
  // Lowercase letters
  if (b >= 0x81 && b <= 0x89) return b - 0x81 + 0x61; // a-i
  if (b >= 0x91 && b <= 0x99) return b - 0x91 + 0x6A; // j-r
  if (b >= 0xA2 && b <= 0xA9) return b - 0xA2 + 0x73; // s-z
  // Digits
  if (b >= 0xF0 && b <= 0xF9) return b - 0xF0 + 0x30; // 0-9
  // Common symbols
  if (b === 0x40) return 0x20; // space
  if (b === 0x4B) return 0x2E; // .
  if (b === 0x6B) return 0x2C; // ,
  if (b === 0x7D) return 0x27; // '
  if (b === 0x5C) return 0x2A; // *
  if (b === 0x60) return 0x2D; // -
  if (b === 0x61) return 0x2F; // /
  if (b === 0x6C) return 0x25; // %
  if (b === 0x50) return 0x26; // &
  if (b === 0x7C) return 0x40; // @
  // Fallback — use ? for unmapped
  return 0x3F;
}

/**
 * Extracts resource reference names from an OBD (Object Area Descriptor) field.
 * The OBD contains triplets. We look for external resource name triplets
 * (triplet ID 0x02 — Fully Qualified Name) and extract the name string.
 */
function extractResourceRefsFromOBD(data: Uint8Array): string[] {
  const refs: string[] = [];
  if (data.length < 2) return refs;

  let i = 0;
  while (i + 2 <= data.length) {
    const tripletLength = data[i];
    if (tripletLength < 2 || i + tripletLength > data.length) break;

    const tripletId = data[i + 1];
    // Triplet 0x02 = Fully Qualified Name
    if (tripletId === 0x02 && tripletLength > 4) {
      // Bytes 2-3: FQN type + format
      // Bytes 4+: name bytes (EBCDIC)
      const nameBytes: number[] = [];
      for (let j = 4; j < tripletLength; j++) {
        const b = data[i + j];
        if (b === 0x40) break; // EBCDIC space = padding
        nameBytes.push(ebcdicToAscii(b));
      }
      if (nameBytes.length > 0) {
        refs.push(String.fromCharCode(...nameBytes));
      }
    }

    i += tripletLength;
  }

  return refs;
}

// -----------------------------------------------------------------------
// Synchronous scan (operates on a full ArrayBuffer)
// -----------------------------------------------------------------------

/**
 * Scans an entire AFP file (as an ArrayBuffer) and builds a page index.
 *
 * This is a Pass 1 scan: it reads only structured field headers, never parses
 * page content. It is O(N) on file size.
 *
 * @param data       - Complete AFP file data.
 * @param onProgress - Optional callback fired every PROGRESS_INTERVAL pages with
 *                     (pagesFound, bytesScanned).
 * @returns Complete array of PageIndexEntry, one per page.
 */
export function scanIndex(
  data: ArrayBuffer,
  onProgress?: (pagesFound: number, bytesScanned: number) => void,
): PageIndexEntry[] {
  const pages: PageIndexEntry[] = [];
  const view = new DataView(data);
  const totalSize = data.byteLength;

  // Tracking state
  let pageNumber = 0;
  let documentIndex = -1;
  let documentName: string | null = null;
  let currentPage: Partial<PageIndexEntry> | null = null;
  let pendingResourceRefs: string[] = [];
  let hasText = false;
  let hasImages = false;
  let lastProgressEmit = 0;

  let offset = 0;

  while (offset < totalSize) {
    const result = readStructuredField(view, offset);
    if (result === null) break;

    const { field, nextOffset } = result;

    try {
      switch (field.typeId) {
        case TYPE_BDT:
          // Begin Document — reset document counters
          documentIndex = -1;
          documentName = null;
          break;

        case TYPE_EDT:
          // End Document — close any unclosed page (malformed file)
          if (currentPage !== null) {
            currentPage.byteLength = offset - (currentPage.byteOffset ?? offset);
            currentPage.hasText = hasText;
            currentPage.hasImages = hasImages;
            currentPage.resourceRefs = [...pendingResourceRefs];
            pages.push(currentPage as PageIndexEntry);
            currentPage = null;
            pendingResourceRefs = [];
            hasText = false;
            hasImages = false;
          }
          break;

        case TYPE_BNG:
          // Begin Named Group
          documentIndex++;
          documentName = extractNameFromBNG(field.data);
          break;

        case TYPE_ENG:
          // End Named Group — close any unclosed page
          if (currentPage !== null) {
            currentPage.byteLength = offset - (currentPage.byteOffset ?? offset);
            currentPage.hasText = hasText;
            currentPage.hasImages = hasImages;
            currentPage.resourceRefs = [...pendingResourceRefs];
            pages.push(currentPage as PageIndexEntry);
            currentPage = null;
            pendingResourceRefs = [];
            hasText = false;
            hasImages = false;
          }
          break;

        case TYPE_BPG:
          // Begin Page — start a new page entry
          pageNumber++;
          hasText = false;
          hasImages = false;
          pendingResourceRefs = [];
          currentPage = {
            pageNumber,
            documentIndex: Math.max(documentIndex, 0),
            documentName,
            byteOffset: field.offset,
            byteLength: 0,
            resourceRefs: [],
            hasText: false,
            hasImages: false,
          };
          break;

        case TYPE_EPG:
          // End Page — close the current page entry
          if (currentPage !== null) {
            // byteLength includes from BPG offset through end of EPG record
            currentPage.byteLength = nextOffset - (currentPage.byteOffset ?? 0);
            currentPage.hasText = hasText;
            currentPage.hasImages = hasImages;
            currentPage.resourceRefs = [...pendingResourceRefs];
            pages.push(currentPage as PageIndexEntry);

            // Emit progress
            if (onProgress && pages.length - lastProgressEmit >= PROGRESS_INTERVAL) {
              lastProgressEmit = pages.length;
              onProgress(pages.length, nextOffset);
            }

            currentPage = null;
          }
          break;

        case TYPE_BPT:
          // Begin Presentation Text — flag that this page has text
          hasText = true;
          break;

        case TYPE_BIM:
          // Begin Image — flag that this page has images
          hasImages = true;
          break;

        case TYPE_OBD:
          // Object Area Descriptor — may contain resource references
          if (currentPage !== null) {
            const refs = extractResourceRefsFromOBD(field.data);
            pendingResourceRefs.push(...refs);
          }
          break;

        default:
          // Skip all other fields — we only care about structural boundaries
          break;
      }
    } catch (err) {
      // Log and continue — a single bad field should not kill the scan
      if (typeof console !== 'undefined') {
        console.warn(
          `AFP index scan: error processing field ${field.typeId} at offset ${field.offset}:`,
          err,
        );
      }
    }

    offset = nextOffset;
  }

  // Handle unclosed page at EOF (truncated file)
  if (currentPage !== null) {
    currentPage.byteLength = totalSize - (currentPage.byteOffset ?? 0);
    currentPage.hasText = hasText;
    currentPage.hasImages = hasImages;
    currentPage.resourceRefs = [...pendingResourceRefs];
    pages.push(currentPage as PageIndexEntry);
  }

  // Final progress emit
  if (onProgress) {
    onProgress(pages.length, totalSize);
  }

  return pages;
}

// -----------------------------------------------------------------------
// Streaming scan (operates on a ReadableStream of chunks)
// -----------------------------------------------------------------------

/**
 * Streaming index scanner that reads from a ReadableStreamDefaultReader.
 *
 * Handles structured fields that span chunk boundaries by accumulating a
 * carry-over buffer. This is critical for large files where the entire
 * ArrayBuffer may not fit in memory.
 *
 * @param reader     - A ReadableStreamDefaultReader<Uint8Array> providing the AFP data.
 * @param onProgress - Optional callback for progress reporting.
 * @param onPage     - Optional callback fired for each completed PageIndexEntry.
 * @returns The complete page index once the stream is exhausted.
 */
export async function scanIndexStreaming(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress?: (pagesFound: number, bytesScanned: number) => void,
  onPage?: (entry: PageIndexEntry) => void,
): Promise<PageIndexEntry[]> {
  const pages: PageIndexEntry[] = [];

  // State tracking (same as synchronous version)
  let pageNumber = 0;
  let documentIndex = -1;
  let documentName: string | null = null;
  let currentPage: Partial<PageIndexEntry> | null = null;
  let pendingResourceRefs: string[] = [];
  let hasText = false;
  let hasImages = false;
  let lastProgressEmit = 0;

  // Accumulated buffer for handling fields that span chunk boundaries
  let carryOver: Uint8Array | null = null;
  let totalBytesRead = 0;

  // How far into the logical stream we have successfully parsed
  let parsedUpTo = 0;

  while (true) {
    const { done, value } = await reader.read();

    // Build the working buffer: carryOver + new chunk
    let buffer: Uint8Array;
    if (carryOver !== null && carryOver.length > 0) {
      if (done || !value) {
        buffer = carryOver;
      } else {
        buffer = new Uint8Array(carryOver.length + value.length);
        buffer.set(carryOver, 0);
        buffer.set(value, carryOver.length);
      }
    } else if (done || !value) {
      break;
    } else {
      buffer = value;
    }

    if (!done && value) {
      totalBytesRead += value.length;
    }

    // Parse as many complete structured fields as we can from `buffer`
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let localOffset = 0;

    while (localOffset < buffer.length) {
      // Check for magic byte
      if (buffer[localOffset] !== MAGIC_BYTE) {
        // Scan forward for the next 0x5A
        let found = false;
        for (let i = localOffset + 1; i < buffer.length; i++) {
          if (buffer[i] === MAGIC_BYTE) {
            localOffset = i;
            found = true;
            break;
          }
        }
        if (!found) {
          // No magic byte in remaining buffer — discard and move on
          localOffset = buffer.length;
          break;
        }
      }

      // Need at least 9 bytes for a minimal structured field header
      if (localOffset + 9 > buffer.length) {
        // Incomplete header — carry over to next chunk
        break;
      }

      // Read LENGTH
      const length = view.getUint16(localOffset + 1, false);
      if (length < 6 || length > 32766) {
        // Bad length — skip this byte and try to re-sync
        localOffset++;
        continue;
      }

      // Check if the full record fits in the current buffer
      const recordEnd = localOffset + 1 + length;
      if (recordEnd > buffer.length) {
        // Incomplete record — carry over
        break;
      }

      // Read TYPE_ID
      const typeId = parseTypeId(
        buffer[localOffset + 3],
        buffer[localOffset + 4],
        buffer[localOffset + 5],
      );

      // Compute absolute file offset for this field
      const absoluteOffset = parsedUpTo + localOffset;

      // Extract data portion
      const dataLength = length - 8;
      let fieldData: Uint8Array;
      if (dataLength > 0 && localOffset + 9 + dataLength <= buffer.length) {
        fieldData = buffer.slice(localOffset + 9, localOffset + 9 + dataLength);
      } else {
        fieldData = new Uint8Array(0);
      }

      // Dispatch on type
      try {
        switch (typeId) {
          case TYPE_BDT:
            documentIndex = -1;
            documentName = null;
            break;

          case TYPE_EDT:
            if (currentPage !== null) {
              currentPage.byteLength = absoluteOffset - (currentPage.byteOffset ?? absoluteOffset);
              currentPage.hasText = hasText;
              currentPage.hasImages = hasImages;
              currentPage.resourceRefs = [...pendingResourceRefs];
              pages.push(currentPage as PageIndexEntry);
              if (onPage) onPage(currentPage as PageIndexEntry);
              currentPage = null;
              pendingResourceRefs = [];
              hasText = false;
              hasImages = false;
            }
            break;

          case TYPE_BNG:
            documentIndex++;
            documentName = extractNameFromBNG(fieldData);
            break;

          case TYPE_ENG:
            if (currentPage !== null) {
              currentPage.byteLength = absoluteOffset - (currentPage.byteOffset ?? absoluteOffset);
              currentPage.hasText = hasText;
              currentPage.hasImages = hasImages;
              currentPage.resourceRefs = [...pendingResourceRefs];
              pages.push(currentPage as PageIndexEntry);
              if (onPage) onPage(currentPage as PageIndexEntry);
              currentPage = null;
              pendingResourceRefs = [];
              hasText = false;
              hasImages = false;
            }
            break;

          case TYPE_BPG:
            pageNumber++;
            hasText = false;
            hasImages = false;
            pendingResourceRefs = [];
            currentPage = {
              pageNumber,
              documentIndex: Math.max(documentIndex, 0),
              documentName,
              byteOffset: absoluteOffset,
              byteLength: 0,
              resourceRefs: [],
              hasText: false,
              hasImages: false,
            };
            break;

          case TYPE_EPG: {
            if (currentPage !== null) {
              const nextAbsoluteOffset = parsedUpTo + recordEnd;
              currentPage.byteLength = nextAbsoluteOffset - (currentPage.byteOffset ?? 0);
              currentPage.hasText = hasText;
              currentPage.hasImages = hasImages;
              currentPage.resourceRefs = [...pendingResourceRefs];
              pages.push(currentPage as PageIndexEntry);
              if (onPage) onPage(currentPage as PageIndexEntry);

              if (onProgress && pages.length - lastProgressEmit >= PROGRESS_INTERVAL) {
                lastProgressEmit = pages.length;
                onProgress(pages.length, totalBytesRead);
              }

              currentPage = null;
            }
            break;
          }

          case TYPE_BPT:
            hasText = true;
            break;

          case TYPE_BIM:
            hasImages = true;
            break;

          case TYPE_OBD:
            if (currentPage !== null) {
              const refs = extractResourceRefsFromOBD(fieldData);
              pendingResourceRefs.push(...refs);
            }
            break;

          default:
            break;
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn(
            `AFP streaming scan: error at field ${typeId}, offset ~${absoluteOffset}:`,
            err,
          );
        }
      }

      localOffset = recordEnd;
    }

    // Update parsedUpTo and save any leftover bytes as carry-over
    parsedUpTo += localOffset;
    if (localOffset < buffer.length) {
      carryOver = buffer.slice(localOffset);
    } else {
      carryOver = null;
    }

    if (done) break;
  }

  // Handle unclosed page at end of stream
  if (currentPage !== null) {
    currentPage.byteLength = totalBytesRead - (currentPage.byteOffset ?? 0);
    currentPage.hasText = hasText;
    currentPage.hasImages = hasImages;
    currentPage.resourceRefs = [...pendingResourceRefs];
    pages.push(currentPage as PageIndexEntry);
    if (onPage) onPage(currentPage as PageIndexEntry);
  }

  if (onProgress) {
    onProgress(pages.length, totalBytesRead);
  }

  return pages;
}

/**
 * Rough estimate of page count based on file size. Uses a heuristic average of
 * ~4 KB per page (typical for text-heavy AFP documents). Returns at least 1 for
 * any non-empty file.
 */
export function estimatePageCount(fileSize: number): number {
  if (fileSize <= 0) return 0;
  return Math.max(1, Math.round(fileSize / ESTIMATED_BYTES_PER_PAGE));
}
