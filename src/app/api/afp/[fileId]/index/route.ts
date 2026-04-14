/**
 * GET /api/afp/[fileId]/index
 *
 * Streams page index data via Server-Sent Events. Reads the AFP file from
 * disk, scans structured field headers to locate BPG/EPG boundaries, and emits
 * SSE events for each page found, periodic progress updates, and a final
 * completion event.
 *
 * The completed index is stored in a global Map so subsequent requests
 * (page fetch, search, render) can look up byte offsets without rescanning.
 */

import { NextRequest, NextResponse } from 'next/server';
import { open, stat } from 'fs/promises';
import path from 'path';
import type { PageIndexEntry } from '@/lib/afp/types';
import { getIndexCache, setIndexCache } from '@/lib/afp/index-cache';

const indexCache = getIndexCache();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AFP_MAGIC = 0x5a;
const BPG_TYPE = 0xd3a8ad; // Begin Page Group
const EPG_TYPE = 0xd3a9ad; // End Page Group

/** Minimum structured field size: 0x5A(1) + LENGTH(2) + TYPE(3) + FLAGS(1) + SEQ(2) = 9 */
const MIN_SF_SIZE = 9;

/** Read buffer size for streaming — 1 MB chunks for good throughput. */
const READ_CHUNK_SIZE = 1024 * 1024;

/** Progress events are sent every N pages. */
const PROGRESS_INTERVAL = 10_000;

function uploadsDir(): string {
  return path.join(process.cwd(), 'uploads');
}

const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}

function sanitizePath(fileId: string): string | null {
  if (!isValidFileId(fileId)) return null;
  const filePath = path.join(uploadsDir(), `${fileId}.afp`);
  // Prevent traversal
  if (!filePath.startsWith(uploadsDir())) return null;
  return filePath;
}

/**
 * Pack three type-ID bytes into a single 24-bit number for fast comparison.
 */
function packType(b1: number, b2: number, b3: number): number {
  return (b1 << 16) | (b2 << 8) | b3;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<NextResponse | Response> {
  const { fileId } = await params;

  // Validate fileId format
  const filePath = sanitizePath(fileId);
  if (!filePath) {
    return NextResponse.json(
      { error: 'Invalid file ID format' },
      { status: 400 },
    );
  }

  // Check file exists
  let fileSize: number;
  try {
    const info = await stat(filePath);
    fileSize = info.size;
  } catch {
    return NextResponse.json(
      { error: 'File not found' },
      { status: 404 },
    );
  }

  // If we already have a cached index, return it immediately as SSE
  const cached = indexCache.get(fileId);
  if (cached) {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const entry of cached) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'page', ...entry })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'complete', totalPages: cached.length })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Stream-scan the file and emit SSE events
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const pages: PageIndexEntry[] = [];

      let fd;
      try {
        fd = await open(filePath, 'r');

        const buf = Buffer.alloc(READ_CHUNK_SIZE);
        let fileOffset = 0;
        let carry = Buffer.alloc(0); // leftover bytes from previous chunk

        let currentPageNumber = 0;
        let currentBpgOffset = -1;
        let objectCountInPage = 0;
        let pagesFound = 0;

        const sendEvent = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        while (fileOffset < fileSize) {
          const bytesToRead = Math.min(READ_CHUNK_SIZE, fileSize - fileOffset);
          const { bytesRead } = await fd.read(buf, 0, bytesToRead, fileOffset);
          if (bytesRead === 0) break;

          // Combine carry from previous chunk with new data
          const chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
          let pos = 0;

          // The absolute file offset of byte 0 in `chunk`
          const chunkBaseOffset = fileOffset - carry.length;

          while (pos < chunk.length) {
            // Find next 0x5A
            if (chunk[pos] !== AFP_MAGIC) {
              pos++;
              continue;
            }

            // Need at least MIN_SF_SIZE bytes from pos
            if (pos + MIN_SF_SIZE > chunk.length) {
              // Not enough bytes — carry the rest to the next iteration
              break;
            }

            // Read LENGTH (2 bytes, big-endian)
            const length = (chunk[pos + 1] << 8) | chunk[pos + 2];

            // Validate length
            if (length < 6 || length > 32766) {
              pos++;
              continue;
            }

            // Full record size = 1 (0x5A) + length
            const recordSize = 1 + length;

            if (pos + recordSize > chunk.length) {
              // Incomplete record — carry
              break;
            }

            // Read TYPE_ID (3 bytes at pos+3..pos+5)
            const typeCode = packType(chunk[pos + 3], chunk[pos + 4], chunk[pos + 5]);
            const absoluteOffset = chunkBaseOffset + pos;

            if (typeCode === BPG_TYPE) {
              currentPageNumber++;
              currentBpgOffset = absoluteOffset;
              objectCountInPage = 0;
            } else if (typeCode === EPG_TYPE && currentBpgOffset >= 0) {
              const byteLength = absoluteOffset + recordSize - currentBpgOffset;
              const entry: PageIndexEntry = {
                pageNumber: currentPageNumber,
                byteOffset: currentBpgOffset,
                byteLength,
                objectCount: objectCountInPage,
              };
              pages.push(entry);
              pagesFound++;

              sendEvent({ type: 'page', ...entry });

              if (pagesFound % PROGRESS_INTERVAL === 0) {
                sendEvent({
                  type: 'progress',
                  pagesFound,
                  bytesScanned: absoluteOffset + recordSize,
                  totalBytes: fileSize,
                });
              }

              currentBpgOffset = -1;
            } else if (currentBpgOffset >= 0) {
              // Count objects inside the current page (BPT, BIM, BGR, BBC)
              const b3 = chunk[pos + 3];
              const b4 = chunk[pos + 4];
              if (b3 === 0xd3 && b4 === 0xa8) {
                objectCountInPage++;
              }
            }

            pos += recordSize;
          }

          // Save unprocessed bytes as carry for next chunk
          if (pos < chunk.length) {
            carry = Buffer.from(chunk.subarray(pos));
          } else {
            carry = Buffer.alloc(0);
          }

          fileOffset += bytesRead;
        }

        // If we're mid-page at EOF (missing EPG), close it out
        if (currentBpgOffset >= 0) {
          const entry: PageIndexEntry = {
            pageNumber: currentPageNumber,
            byteOffset: currentBpgOffset,
            byteLength: fileSize - currentBpgOffset,
            objectCount: objectCountInPage,
          };
          pages.push(entry);
          pagesFound++;
          sendEvent({ type: 'page', ...entry });
        }

        // Store in cache
        setIndexCache(fileId, pages);

        sendEvent({
          type: 'complete',
          totalPages: pagesFound,
          fileSize,
        });

        controller.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Index scan failed';
        console.error('Index scan error:', message);
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'error', message })}\n\n`,
            ),
          );
        } catch {
          // Controller may already be closed
        }
        controller.close();
      } finally {
        if (fd) await fd.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
