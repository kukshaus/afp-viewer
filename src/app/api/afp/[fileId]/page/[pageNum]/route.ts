/**
 * GET /api/afp/[fileId]/page/[pageNum]
 *
 * Returns the raw AFP bytes for a specific page. The byte range is looked up
 * from the in-memory page index built by the index scan route. The response is
 * an application/octet-stream containing the BPG-to-EPG structured fields.
 */

import { NextRequest, NextResponse } from 'next/server';
import { open } from 'fs/promises';
import path from 'path';
import { getIndexCache } from '@/lib/afp/index-cache';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

function sanitizePath(fileId: string): string | null {
  if (!isValidFileId(fileId)) return null;
  const filePath = path.join(UPLOADS_DIR, `${fileId}.afp`);
  // Prevent directory traversal
  if (!filePath.startsWith(UPLOADS_DIR)) return null;
  return filePath;
}

function isPositiveInt(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string; pageNum: string }> },
): Promise<NextResponse | Response> {
  const { fileId, pageNum } = await params;

  // --- Validate fileId ---
  const filePath = sanitizePath(fileId);
  if (!filePath) {
    return NextResponse.json(
      { error: 'Invalid file ID format. Expected a UUID.' },
      { status: 400 },
    );
  }

  // --- Validate pageNum ---
  if (!isPositiveInt(pageNum)) {
    return NextResponse.json(
      { error: 'Invalid page number. Must be a positive integer.' },
      { status: 400 },
    );
  }
  const requestedPage = parseInt(pageNum, 10);

  // --- Look up index cache ---
  const indexCache = getIndexCache();
  const pages = indexCache.get(fileId);
  if (!pages) {
    return NextResponse.json(
      {
        error: 'Index not built yet. Call GET /api/afp/[fileId]/index first.',
      },
      { status: 404 },
    );
  }

  // --- Find the page entry (1-based page numbers) ---
  const entry = pages.find((p) => p.pageNumber === requestedPage);
  if (!entry) {
    return NextResponse.json(
      {
        error: `Page ${requestedPage} not found. File contains ${pages.length} page(s).`,
      },
      { status: 404 },
    );
  }

  // --- Read the byte range from disk ---
  let fd;
  try {
    fd = await open(filePath, 'r');
    const buffer = Buffer.alloc(entry.byteLength);
    const { bytesRead } = await fd.read(
      buffer,
      0,
      entry.byteLength,
      entry.byteOffset,
    );

    if (bytesRead !== entry.byteLength) {
      return NextResponse.json(
        {
          error: `Short read: expected ${entry.byteLength} bytes, got ${bytesRead}.`,
        },
        { status: 500 },
      );
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(entry.byteLength),
        'X-AFP-Page-Number': String(entry.pageNumber),
        'X-AFP-Byte-Offset': String(entry.byteOffset),
        'X-AFP-Byte-Length': String(entry.byteLength),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to read page';

    // Distinguish file-not-found from other I/O errors
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return NextResponse.json(
        { error: 'AFP file not found on disk.' },
        { status: 404 },
      );
    }

    console.error('Page read error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (fd) await fd.close();
  }
}
