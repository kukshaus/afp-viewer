/**
 * Global server-side page-index cache.
 *
 * Shared across API routes so that once an AFP file is indexed, subsequent
 * page-fetch / search / render requests can look up byte offsets instantly.
 */

import type { PageIndexEntry } from '@/lib/afp/types';

/** fileId -> PageIndexEntry[] */
const indexCache = new Map<string, PageIndexEntry[]>();

export function getIndexCache(): Map<string, PageIndexEntry[]> {
  return indexCache;
}

export function setIndexCache(fileId: string, pages: PageIndexEntry[]): void {
  indexCache.set(fileId, pages);
}

export function getFileIndex(fileId: string): PageIndexEntry[] | undefined {
  return indexCache.get(fileId);
}
