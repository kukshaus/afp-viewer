/**
 * GET /api/afp/[fileId]/search?q=<query>&maxResults=100
 *
 * Full-text search across indexed AFP pages. Currently returns an empty result
 * set because text extraction requires parsing each page's PTOCA content, which
 * is not yet wired into the index scan. Once the text extraction pipeline is
 * complete, results will be populated using the Orama in-memory search index.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIndexCache } from '@/lib/afp/index-cache';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}

const MAX_RESULTS_UPPER = 1000;
const DEFAULT_MAX_RESULTS = 100;

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

  // --- Parse query params ---
  const { searchParams } = request.nextUrl;
  const query = searchParams.get('q');
  const maxResultsParam = searchParams.get('maxResults');

  if (!query || query.trim().length === 0) {
    return NextResponse.json(
      { error: 'Missing required query parameter "q".' },
      { status: 400 },
    );
  }

  let maxResults = DEFAULT_MAX_RESULTS;
  if (maxResultsParam !== null) {
    maxResults = parseInt(maxResultsParam, 10);
    if (isNaN(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_UPPER) {
      return NextResponse.json(
        {
          error: `Invalid maxResults. Must be an integer between 1 and ${MAX_RESULTS_UPPER}.`,
        },
        { status: 400 },
      );
    }
  }

  // --- Look up index cache ---
  const indexCache = getIndexCache();
  const pages = indexCache.get(fileId);
  if (!pages) {
    return NextResponse.json(
      {
        error:
          'Index not built yet. Call GET /api/afp/[fileId]/index first to scan the file.',
      },
      { status: 404 },
    );
  }

  // --- Search (stub: text extraction not yet implemented) ---
  // Once PTOCA text extraction is wired in, each PageIndexEntry will have a
  // textContent field populated, and we will use Orama to build a full-text
  // index. For now, return an empty result set.

  return NextResponse.json(
    {
      query: query.trim(),
      fileId,
      totalPages: pages.length,
      results: [],
      totalMatches: 0,
      maxResults,
      note:
        'Text extraction from AFP pages is not yet implemented. Search results ' +
        'will be populated once the PTOCA parser extracts text content from ' +
        'each page and builds the Orama full-text search index.',
    },
    { status: 200 },
  );
}
