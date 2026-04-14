/**
 * GET /api/afp/[fileId]/render/[pageNum]?dpi=150&format=png
 *
 * Placeholder for server-side page rendering. Full implementation will use
 * node-canvas (Cairo) to rasterise the AFP page render tree into a PNG or
 * JPEG image. For now this returns a 501 with guidance on the client-side
 * rendering path.
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

function isPositiveInt(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp']);
const MIN_DPI = 36;
const MAX_DPI = 600;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string; pageNum: string }> },
): Promise<NextResponse> {
  const { fileId, pageNum } = await params;

  // --- Validate fileId ---
  if (!isValidFileId(fileId)) {
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

  // --- Parse query params ---
  const { searchParams } = request.nextUrl;
  const dpiParam = searchParams.get('dpi') ?? '150';
  const format = searchParams.get('format') ?? 'png';

  const dpi = parseInt(dpiParam, 10);
  if (isNaN(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    return NextResponse.json(
      {
        error: `Invalid DPI value. Must be an integer between ${MIN_DPI} and ${MAX_DPI}.`,
      },
      { status: 400 },
    );
  }

  if (!ALLOWED_FORMATS.has(format)) {
    return NextResponse.json(
      {
        error: `Invalid format "${format}". Allowed values: ${[...ALLOWED_FORMATS].join(', ')}`,
      },
      { status: 400 },
    );
  }

  // --- Return 501 placeholder ---
  return NextResponse.json(
    {
      error: 'Server-side rendering not yet implemented',
      status: 501,
      details: {
        fileId,
        pageNumber: parseInt(pageNum, 10),
        requestedDpi: dpi,
        requestedFormat: format,
      },
      clientSideRendering: {
        description:
          'Client-side rendering is available and recommended for files under 256 MB. ' +
          'The browser-based pipeline uses Web Workers and OffscreenCanvas for ' +
          'high-performance rendering without server round-trips.',
        steps: [
          '1. Call GET /api/afp/[fileId]/index to build the page index (SSE stream).',
          '2. Call GET /api/afp/[fileId]/page/[pageNum] to fetch raw AFP bytes for a page.',
          '3. Pass the bytes to the client-side AFP parser (Web Worker) to build a PageRenderTree.',
          '4. Send the PageRenderTree to the render worker which draws to an OffscreenCanvas.',
          '5. Transfer the resulting ImageBitmap to the main thread for display.',
        ],
      },
      serverSideImplementation: {
        description:
          'Server-side rendering will use node-canvas (Cairo) to rasterise AFP pages. ' +
          'This is required for files larger than 256 MB where the full file cannot ' +
          'be loaded into browser memory.',
        requiredPackages: ['canvas (node-canvas)', '@napi-rs/canvas (alternative)'],
      },
    },
    { status: 501 },
  );
}
