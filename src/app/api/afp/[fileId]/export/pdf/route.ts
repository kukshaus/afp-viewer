/**
 * GET /api/afp/[fileId]/export/pdf?pages=1-10,42
 *
 * Placeholder for PDF export. Full implementation will use pdf-lib to compose
 * rendered AFP pages into a downloadable PDF document. Currently returns a 501
 * with the parsed page list and installation instructions.
 */

import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}

/**
 * Parse a page-range string such as "1-10,42,50-55" into an array of
 * individual page numbers. Returns null if the format is invalid.
 */
function parsePageRanges(input: string): number[] | null {
  const pages = new Set<number>();
  const segments = input.split(',');

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;

    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end < 1 || start > end) return null;
      // Guard against absurdly large ranges
      if (end - start > 10_000) return null;
      for (let i = start; i <= end; i++) {
        pages.add(i);
      }
    } else if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (num < 1) return null;
      pages.add(num);
    } else {
      // Unrecognised format
      return null;
    }
  }

  if (pages.size === 0) return null;

  return Array.from(pages).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<NextResponse> {
  const { fileId } = await params;

  // --- Validate fileId ---
  if (!isValidFileId(fileId)) {
    return NextResponse.json(
      { error: 'Invalid file ID format. Expected a UUID.' },
      { status: 400 },
    );
  }

  // --- Parse page ranges ---
  const { searchParams } = request.nextUrl;
  const pagesParam = searchParams.get('pages');

  let parsedPages: number[] | null = null;

  if (pagesParam) {
    parsedPages = parsePageRanges(pagesParam);
    if (!parsedPages) {
      return NextResponse.json(
        {
          error:
            'Invalid pages format. Use comma-separated page numbers or ranges, ' +
            'e.g. "1-10,42,50-55". Page numbers must be positive integers and ' +
            'ranges must not exceed 10,000 pages.',
        },
        { status: 400 },
      );
    }
  }

  // --- Return 501 placeholder ---
  return NextResponse.json(
    {
      error:
        'PDF export requires pdf-lib. Install with: npm install pdf-lib',
      status: 501,
      fileId,
      pages: parsedPages ?? 'all (no page filter specified)',
      pageCount: parsedPages?.length ?? null,
      implementation: {
        description:
          'PDF export will render each requested AFP page to a raster image ' +
          '(using the server-side render pipeline) and embed the images into ' +
          'a multi-page PDF document using pdf-lib.',
        requiredPackages: [
          'pdf-lib — Pure JavaScript PDF creation and modification',
          'canvas (node-canvas) — Server-side AFP page rendering via Cairo',
        ],
        steps: [
          '1. Parse and validate the requested page ranges.',
          '2. For each page, fetch raw AFP bytes and parse into a PageRenderTree.',
          '3. Render each PageRenderTree to a PNG buffer using node-canvas.',
          '4. Create a PDFDocument with pdf-lib and embed each PNG as a page.',
          '5. Stream the finalized PDF bytes back to the client.',
        ],
      },
    },
    { status: 501 },
  );
}
