/**
 * Search Index
 *
 * Builds a pre-computed search index from all AFP pages in the background.
 * Once built, searches are instant (sub-millisecond) regardless of document size.
 *
 * Architecture:
 *   1. After file loads, a background indexer processes pages in batches
 *   2. Text + TLE data is extracted using the fast text-only extractor
 *   3. An inverted trigram index enables instant substring matching
 *   4. Results are returned from the pre-built index — no re-parsing needed
 *
 * The trigram index supports:
 *   - Case-insensitive substring search
 *   - Sub-millisecond query times even for 10,000+ page documents
 *   - Progressive results (search works on already-indexed pages)
 */

import type { PageIndex } from '@/lib/afp/types';
import { extractPageData, extractAllTles } from './text-extractor';
import type { ExtractedPageData } from './text-extractor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchHit {
  pageNumber: number;
  excerpt: string;
  matchIndex: number;
  type: 'text' | 'tle';
  tleKey?: string;
}

export interface SearchIndexState {
  /** How many pages have been indexed so far */
  indexedPages: number;
  /** Total pages to index */
  totalPages: number;
  /** Whether indexing is complete */
  isComplete: boolean;
  /** Whether indexing is currently running */
  isIndexing: boolean;
}

// ---------------------------------------------------------------------------
// Page data store
// ---------------------------------------------------------------------------

interface PageEntry {
  pageNumber: number;
  textLower: string;       // lowercase text for matching
  textOriginal: string;    // original text for excerpts
  tles: Array<{ key: string; value: string; combined: string; combinedLower: string }>;
}

// ---------------------------------------------------------------------------
// Trigram inverted index
// ---------------------------------------------------------------------------

/**
 * Extracts all trigrams (3-character substrings) from a string.
 * For strings shorter than 3 chars, returns bigrams or the string itself.
 */
function extractTrigrams(str: string): Set<string> {
  const trigrams = new Set<string>();
  if (str.length <= 2) {
    trigrams.add(str);
    return trigrams;
  }
  for (let i = 0; i <= str.length - 3; i++) {
    trigrams.add(str.substring(i, i + 3));
  }
  return trigrams;
}

// ---------------------------------------------------------------------------
// Search Index class
// ---------------------------------------------------------------------------

export class AfpSearchIndex {
  private pages: Map<number, PageEntry> = new Map();
  /** Trigram → set of page numbers that contain this trigram in text */
  private textTrigrams: Map<string, Set<number>> = new Map();
  /** Trigram → set of page numbers that contain this trigram in TLE */
  private tleTrigrams: Map<string, Set<number>> = new Map();

  private _indexedPages = 0;
  private _totalPages = 0;
  private _isIndexing = false;
  private _isComplete = false;
  private _abortController: AbortController | null = null;
  private _fileKey = '';

  get state(): SearchIndexState {
    return {
      indexedPages: this._indexedPages,
      totalPages: this._totalPages,
      isComplete: this._isComplete,
      isIndexing: this._isIndexing,
    };
  }

  /**
   * Start building the search index in the background.
   * Processes pages in batches, yielding to the UI thread between batches.
   */
  async build(
    fileData: ArrayBuffer,
    pageIndex: PageIndex[],
    onProgress?: (state: SearchIndexState) => void,
  ): Promise<void> {
    // Abort any in-progress indexing
    this.abort();

    // Generate a file key to detect stale indexing
    const fileKey = `${fileData.byteLength}-${pageIndex.length}`;
    if (this._fileKey === fileKey && this._isComplete) {
      // Already indexed this exact file
      onProgress?.(this.state);
      return;
    }

    // Reset state
    this.pages.clear();
    this.textTrigrams.clear();
    this.tleTrigrams.clear();
    this._indexedPages = 0;
    this._totalPages = pageIndex.length;
    this._isIndexing = true;
    this._isComplete = false;
    this._fileKey = fileKey;
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    onProgress?.(this.state);

    // ----- Pass A: Full-file TLE scan -----
    // This catches TLEs that exist OUTSIDE page byte ranges (document-level,
    // named-group-level, between BRS records, etc.). Each TLE is associated
    // with the page whose byte range contains it, or — if it falls in a gap —
    // the nearest preceding page (or the next page if at the very start).
    const allFileTles = extractAllTles(fileData);

    // Build a sorted list of page byte offsets for fast binary-search assignment
    const sortedPages = [...pageIndex].sort((a, b) => a.byteOffset - b.byteOffset);

    // Map: pageNumber → list of TLEs assigned to that page (in addition to
    // those discovered during the per-page scan)
    const extraTlesByPage = new Map<number, Array<{ key: string; value: string }>>();

    // Track which TLE offsets are already inside a page byte range, so we
    // don't double-add them after the per-page scan picks them up.
    const tlesInsidePages = new Set<number>();

    for (const tle of allFileTles) {
      // First check if the TLE is inside any page byte range
      const containing = findContainingPage(sortedPages, tle.offset);
      if (containing) {
        // Will be picked up by per-page scan, skip
        tlesInsidePages.add(tle.offset);
        continue;
      }

      // TLE is in a gap. AFP document-level TLEs typically appear BEFORE
      // the pages they describe (as part of opening a new document/named
      // group), so assign to the NEXT page. Fall back to the last page only
      // if there is no next page.
      const targetPage =
        findNextPage(sortedPages, tle.offset) ??
        sortedPages[sortedPages.length - 1];
      if (!targetPage) continue;

      let list = extraTlesByPage.get(targetPage.pageNumber);
      if (!list) {
        list = [];
        extraTlesByPage.set(targetPage.pageNumber, list);
      }
      list.push({ key: tle.key, value: tle.value });
    }

    // ----- Pass B: Per-page text + TLE extraction -----
    const BATCH_SIZE = 50; // pages per batch before yielding

    for (let i = 0; i < pageIndex.length; i += BATCH_SIZE) {
      if (signal.aborted) return;

      const batchEnd = Math.min(i + BATCH_SIZE, pageIndex.length);

      for (let j = i; j < batchEnd; j++) {
        if (signal.aborted) return;

        const entry = pageIndex[j];
        const extracted = extractPageData(
          fileData,
          entry.byteOffset,
          entry.byteLength,
          entry.pageNumber,
        );

        // Merge in any extra TLEs from the full-file scan that fell in gaps
        const extras = extraTlesByPage.get(entry.pageNumber);
        if (extras) {
          extracted.tles.push(...extras);
        }

        this.addPage(extracted);
        this._indexedPages = j + 1;
      }

      onProgress?.(this.state);

      // Yield to UI thread between batches
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!signal.aborted) {
      this._isComplete = true;
      this._isIndexing = false;
      onProgress?.(this.state);
    }
  }

  /**
   * Abort in-progress indexing.
   */
  abort(): void {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._isIndexing = false;
  }

  /**
   * Add a single page's data to the index.
   */
  private addPage(data: ExtractedPageData): void {
    const textLower = data.text.toLowerCase();
    const tles = data.tles.map((t) => ({
      key: t.key,
      value: t.value,
      combined: `${t.key} = ${t.value}`,
      combinedLower: `${t.key} = ${t.value}`.toLowerCase(),
    }));

    this.pages.set(data.pageNumber, {
      pageNumber: data.pageNumber,
      textLower,
      textOriginal: data.text,
      tles,
    });

    // Index text trigrams
    if (textLower.length > 0) {
      const trigrams = extractTrigrams(textLower);
      for (const tri of trigrams) {
        let set = this.textTrigrams.get(tri);
        if (!set) {
          set = new Set();
          this.textTrigrams.set(tri, set);
        }
        set.add(data.pageNumber);
      }
    }

    // Index TLE trigrams
    for (const tle of tles) {
      if (tle.combinedLower.length > 0) {
        const trigrams = extractTrigrams(tle.combinedLower);
        for (const tri of trigrams) {
          let set = this.tleTrigrams.get(tri);
          if (!set) {
            set = new Set();
            this.tleTrigrams.set(tri, set);
          }
          set.add(data.pageNumber);
        }
      }
    }
  }

  /**
   * Search the index. Returns results in < 1ms for most queries.
   *
   * @param query     - Search string (case-insensitive)
   * @param type      - Filter: 'all', 'text', or 'tle'
   * @param maxResults - Maximum results to return (default 500)
   */
  search(
    query: string,
    type: 'all' | 'text' | 'tle' = 'all',
    maxResults: number = 500,
  ): SearchHit[] {
    if (!query.trim()) return [];

    const lowerQuery = query.toLowerCase().trim();
    const results: SearchHit[] = [];

    // Use trigrams to narrow candidate pages, then verify with actual substring match
    const candidatePages = this.getCandidatePages(lowerQuery, type);

    for (const pageNum of candidatePages) {
      if (results.length >= maxResults) break;

      const page = this.pages.get(pageNum);
      if (!page) continue;

      // Search TLEs
      if (type === 'all' || type === 'tle') {
        for (const tle of page.tles) {
          if (results.length >= maxResults) break;
          if (tle.combinedLower.includes(lowerQuery)) {
            results.push({
              pageNumber: page.pageNumber,
              excerpt: tle.combined,
              matchIndex: tle.combinedLower.indexOf(lowerQuery),
              type: 'tle',
              tleKey: tle.key,
            });
          }
        }
      }

      // Search text
      if (type === 'all' || type === 'text') {
        let pos = 0;
        while (pos < page.textLower.length && results.length < maxResults) {
          const idx = page.textLower.indexOf(lowerQuery, pos);
          if (idx === -1) break;

          const start = Math.max(0, idx - 30);
          const end = Math.min(
            page.textOriginal.length,
            idx + query.length + 30,
          );

          results.push({
            pageNumber: page.pageNumber,
            excerpt:
              (start > 0 ? '...' : '') +
              page.textOriginal.slice(start, end) +
              (end < page.textOriginal.length ? '...' : ''),
            matchIndex: idx,
            type: 'text',
          });
          pos = idx + 1;
        }
      }
    }

    return results;
  }

  /**
   * Get candidate pages that might contain the query string.
   * Uses trigram intersection for fast narrowing.
   */
  private getCandidatePages(
    lowerQuery: string,
    type: 'all' | 'text' | 'tle',
  ): number[] {
    const queryTrigrams = extractTrigrams(lowerQuery);

    // For very short queries (1-2 chars), fall back to scanning all pages
    if (lowerQuery.length < 3) {
      const allPages = new Set<number>();
      for (const [pageNum] of this.pages) {
        allPages.add(pageNum);
      }
      return Array.from(allPages).sort((a, b) => a - b);
    }

    let candidateSet: Set<number> | null = null;

    // Intersect trigram posting lists for text
    if (type === 'all' || type === 'text') {
      for (const tri of queryTrigrams) {
        const pageSet = this.textTrigrams.get(tri);
        if (!pageSet) {
          // If any trigram has no matches, text candidates are empty
          // But only skip if we're exclusively searching text
          if (type === 'text') return [];
          break;
        }
        if (candidateSet === null) {
          candidateSet = new Set(pageSet);
        } else {
          for (const p of candidateSet) {
            if (!pageSet.has(p)) candidateSet.delete(p);
          }
        }
      }
    }

    // Union with TLE candidates
    if (type === 'all' || type === 'tle') {
      let tleCandidates: Set<number> | null = null;
      for (const tri of queryTrigrams) {
        const pageSet = this.tleTrigrams.get(tri);
        if (!pageSet) {
          if (type === 'tle') return [];
          tleCandidates = new Set();
          break;
        }
        if (tleCandidates === null) {
          tleCandidates = new Set(pageSet);
        } else {
          for (const p of tleCandidates) {
            if (!pageSet.has(p)) tleCandidates.delete(p);
          }
        }
      }

      if (tleCandidates) {
        if (candidateSet === null) {
          candidateSet = tleCandidates;
        } else {
          for (const p of tleCandidates) {
            candidateSet.add(p);
          }
        }
      }
    }

    if (!candidateSet) return [];
    return Array.from(candidateSet).sort((a, b) => a - b);
  }

  /**
   * Get the number of indexed pages.
   */
  get indexedCount(): number {
    return this._indexedPages;
  }

  /**
   * Reset the index (e.g., when a new file is loaded).
   */
  reset(): void {
    this.abort();
    this.pages.clear();
    this.textTrigrams.clear();
    this.tleTrigrams.clear();
    this._indexedPages = 0;
    this._totalPages = 0;
    this._isComplete = false;
    this._isIndexing = false;
    this._fileKey = '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Binary-search for the page whose byte range strictly contains `offset`.
 * Returns null if no page contains it (i.e. the offset falls in a gap).
 */
function findContainingPage(
  sortedPages: PageIndex[],
  offset: number,
): PageIndex | null {
  if (sortedPages.length === 0) return null;

  let lo = 0;
  let hi = sortedPages.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = sortedPages[mid];
    const start = p.byteOffset;
    const end = p.byteOffset + p.byteLength;

    if (offset < start) {
      hi = mid - 1;
    } else if (offset >= end) {
      lo = mid + 1;
    } else {
      return p;
    }
  }

  return null;
}

/**
 * Binary-search for the first page whose byte offset is strictly greater than
 * `offset` — i.e. the next page after the given offset. Returns null if there
 * is no such page (offset is at or after the last page).
 */
function findNextPage(
  sortedPages: PageIndex[],
  offset: number,
): PageIndex | null {
  if (sortedPages.length === 0) return null;

  let lo = 0;
  let hi = sortedPages.length - 1;
  let result: PageIndex | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = sortedPages[mid];
    if (p.byteOffset > offset) {
      result = p;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: AfpSearchIndex | null = null;

export function getSearchIndex(): AfpSearchIndex {
  if (!_instance) {
    _instance = new AfpSearchIndex();
  }
  return _instance;
}

export function resetSearchIndex(): void {
  if (_instance) {
    _instance.reset();
  }
}
