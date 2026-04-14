'use client';

import { useCallback, useRef } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import type { PageIndex } from '@/lib/afp/types';
import { getSearchIndex, resetSearchIndex } from '@/lib/search/search-index';

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAGIC_BYTE = 0x5A;

// Page boundary type IDs
const BPG = 0xD3A8AD;
const EPG = 0xD3A9AD;
const BRS = 0xD3A8AF;
const ERS = 0xD3A9AF;
const BDT = 0xD3A8A8;
const EDT = 0xD3A9A8;
const BPF = 0xD3A8A5;
const EPF = 0xD3A9A5;

/**
 * Async page index builder that yields to the UI thread periodically.
 * Scans for pages using multiple strategies in a single pass.
 */
async function buildPageIndexAsync(
  buffer: ArrayBuffer,
  onProgress: (pagesFound: number, percent: number) => void,
): Promise<PageIndex[]> {
  const view = new DataView(buffer);
  const totalSize = buffer.byteLength;

  // Track pages for all strategies simultaneously in one pass
  const strategies = [
    { begin: BPG, end: EPG, pages: [] as PageIndex[], current: -1, num: 0 },
    { begin: BRS, end: ERS, pages: [] as PageIndex[], current: -1, num: 0 },
    { begin: BDT, end: EDT, pages: [] as PageIndex[], current: -1, num: 0 },
    { begin: BPF, end: EPF, pages: [] as PageIndex[], current: -1, num: 0 },
  ];

  let offset = 0;
  let fieldCount = 0;
  let lastYield = Date.now();

  while (offset < totalSize) {
    if (view.getUint8(offset) !== MAGIC_BYTE) { offset++; continue; }
    if (offset + 9 > totalSize) break;

    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }

    const typeId =
      (view.getUint8(offset + 3) << 16) |
      (view.getUint8(offset + 4) << 8) |
      view.getUint8(offset + 5);

    const nextOffset = offset + 1 + length;

    // Check all strategies
    for (const s of strategies) {
      if (typeId === s.begin) {
        s.num++;
        s.current = offset;
      } else if (typeId === s.end && s.current >= 0) {
        s.pages.push({
          pageNumber: s.num,
          byteOffset: s.current,
          byteLength: nextOffset - s.current,
        });
        s.current = -1;
      }
    }

    fieldCount++;

    // Yield to UI every 16ms (~60fps) to keep it responsive
    const now = Date.now();
    if (now - lastYield > 16) {
      lastYield = now;
      const percent = Math.round((offset / totalSize) * 100);
      const bestPages = strategies.reduce((best, s) => s.pages.length > best ? s.pages.length : best, 0);
      onProgress(bestPages, percent);
      // Yield to main thread
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  // Close any unclosed pages at EOF
  for (const s of strategies) {
    if (s.current >= 0) {
      s.pages.push({
        pageNumber: s.num,
        byteOffset: s.current,
        byteLength: totalSize - s.current,
      });
    }
  }

  // Return the strategy with the MOST pages (e.g. BRS gives 2281 vs BPG 1070
  // because each BRS is a separate physical page within a BPG group)
  let bestStrategy = strategies[0];
  for (const s of strategies) {
    if (s.pages.length > bestStrategy.pages.length) {
      bestStrategy = s;
    }
  }
  if (bestStrategy.pages.length > 0) return bestStrategy.pages;

  // Fallback: whole file as one page
  if (totalSize > 0) {
    return [{ pageNumber: 1, byteOffset: 0, byteLength: totalSize }];
  }

  return [];
}

/**
 * Hook encapsulating all AFP viewer logic.
 */
export function useAfpViewer() {
  const store = useAfpViewerStore();
  const indexWorkerRef = useRef<Worker | null>(null);

  const handleFileLoad = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_SIZE) {
        store.setError(`File too large (${(file.size / 1e9).toFixed(2)} GB). Max 2 GB.`);
        return;
      }

      const ext = file.name.toLowerCase().split('.').pop();
      if (ext !== 'afp' && ext !== 'afp2') {
        store.setError('Invalid file type. Please select an AFP file.');
        return;
      }

      store.reset();
      resetSearchIndex();
      store.setStatus('indexing');
      store.setIndexProgress(0, 0);

      try {
        const buffer = await file.arrayBuffer();
        store.setFile(file.name, file.size, buffer);

        const pages = await buildPageIndexAsync(buffer, (pagesFound, percent) => {
          store.setIndexProgress(percent, pagesFound);
        });

        if (pages.length === 0) {
          store.setError('No pages found in the AFP file. The file may be corrupt or not a valid AFP document.');
          return;
        }

        store.setIndexProgress(100, pages.length);
        store.setPageIndex(pages);

        // Start building search index eagerly in the background
        getSearchIndex().build(buffer, pages);
      } catch (err) {
        store.setError(err instanceof Error ? err.message : 'Unknown error loading file');
      }
    },
    [store],
  );

  const closeFile = useCallback(() => {
    if (indexWorkerRef.current) {
      indexWorkerRef.current.terminate();
      indexWorkerRef.current = null;
    }
    store.reset();
    resetSearchIndex();
  }, [store]);

  return {
    status: store.status,
    fileName: store.fileName,
    fileSize: store.fileSize,
    fileData: store.fileData,
    pageIndex: store.pageIndex,
    indexProgress: store.indexProgress,
    pagesFound: store.pagesFound,
    currentPage: store.currentPage,
    totalPages: store.totalPages,
    zoom: store.zoom,
    rotation: store.rotation,
    fitMode: store.fitMode,
    sidebarOpen: store.sidebarOpen,
    searchOpen: store.searchOpen,
    currentPageBitmap: store.currentPageBitmap,
    thumbnails: store.thumbnails,
    isPageLoading: store.isPageLoading,
    searchQuery: store.searchQuery,
    searchResults: store.searchResults,
    currentSearchIndex: store.currentSearchIndex,
    errorMessage: store.errorMessage,
    handleFileLoad,
    closeFile,
    setCurrentPage: store.setCurrentPage,
    nextPage: store.nextPage,
    prevPage: store.prevPage,
    goToPage: store.goToPage,
    setZoom: store.setZoom,
    zoomIn: store.zoomIn,
    zoomOut: store.zoomOut,
    setRotation: store.setRotation,
    rotateClockwise: store.rotateClockwise,
    setFitMode: store.setFitMode,
    toggleSidebar: store.toggleSidebar,
    toggleSearch: store.toggleSearch,
    setSearchQuery: store.setSearchQuery,
    setSearchResults: store.setSearchResults,
    setCurrentSearchIndex: store.setCurrentSearchIndex,
    setError: store.setError,
    setStatus: store.setStatus,
    setCurrentPageBitmap: store.setCurrentPageBitmap,
    setIsPageLoading: store.setIsPageLoading,
    reset: store.reset,
  };
}
