'use client';

import { create } from 'zustand';
import type { PageIndex } from '@/lib/afp/types';

export type ViewerStatus = 'idle' | 'loading' | 'indexing' | 'ready' | 'error';

export interface SearchResult {
  pageNumber: number;
  excerpt: string;
  matchIndex: number;
}

export interface AfpViewerState {
  // File state
  status: ViewerStatus;
  fileName: string | null;
  fileSize: number;
  fileData: ArrayBuffer | null;

  // Indexing
  pageIndex: PageIndex[];
  indexProgress: number; // 0-100
  pagesFound: number;

  // Navigation
  currentPage: number;
  totalPages: number;

  // View
  zoom: number;
  rotation: number; // 0, 90, 180, 270
  fitMode: 'none' | 'width' | 'page';
  sidebarOpen: boolean;
  searchOpen: boolean;
  elementTreeOpen: boolean;
  elementSelectMode: boolean;
  selectedElementId: string | null;
  selectedElementOffset: number | null;
  diagnosticsOpen: boolean;
  docInfoOpen: boolean;
  exportOpen: boolean;
  splitOpen: boolean;

  // Settings
  showEndTags: boolean;
  showPlaceholders: boolean;
  docDividerTle: string; // TLE key that marks document boundaries (empty = use BDT)

  // Rendering
  currentPageBitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null;
  thumbnails: Map<number, ImageBitmap | HTMLCanvasElement | OffscreenCanvas>;
  isPageLoading: boolean;

  // Search
  searchQuery: string;
  searchResults: SearchResult[];
  currentSearchIndex: number;

  // Error
  errorMessage: string | null;

  // Actions
  setStatus: (status: ViewerStatus) => void;
  setFile: (name: string, size: number, data: ArrayBuffer) => void;
  setPageIndex: (index: PageIndex[]) => void;
  setIndexProgress: (progress: number, pagesFound: number) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setRotation: (rotation: number) => void;
  rotateClockwise: () => void;
  setFitMode: (mode: 'none' | 'width' | 'page') => void;
  toggleSidebar: () => void;
  toggleSearch: () => void;
  toggleElementTree: () => void;
  toggleElementSelectMode: () => void;
  togglePlaceholders: () => void;
  toggleExport: () => void;
  setDocDividerTle: (key: string) => void;
  setSelectedElementId: (id: string | null) => void;
  setSelectedElementOffset: (offset: number | null) => void;
  setCurrentPageBitmap: (bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null) => void;
  setThumbnail: (page: number, bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas) => void;
  setIsPageLoading: (loading: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: SearchResult[]) => void;
  setCurrentSearchIndex: (index: number) => void;
  setError: (message: string | null) => void;
  nextPage: () => void;
  prevPage: () => void;
  goToPage: (page: number) => void;
  reset: () => void;
}

const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400];

const initialState = {
  status: 'idle' as ViewerStatus,
  fileName: null as string | null,
  fileSize: 0,
  fileData: null as ArrayBuffer | null,
  pageIndex: [] as PageIndex[],
  indexProgress: 0,
  pagesFound: 0,
  currentPage: 1,
  totalPages: 0,
  zoom: 100,
  rotation: 0,
  fitMode: 'none' as const,
  sidebarOpen: true,
  searchOpen: false,
  elementTreeOpen: true,
  elementSelectMode: false,
  selectedElementId: null as string | null,
  selectedElementOffset: null as number | null,
  diagnosticsOpen: false,
  docInfoOpen: false,
  exportOpen: false,
  splitOpen: false,
  showEndTags: false,
  showPlaceholders: true,
  docDividerTle: '' as string,
  currentPageBitmap: null as ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null,
  thumbnails: new Map<number, ImageBitmap | HTMLCanvasElement | OffscreenCanvas>(),
  isPageLoading: false,
  searchQuery: '',
  searchResults: [] as SearchResult[],
  currentSearchIndex: -1,
  errorMessage: null as string | null,
};

export const useAfpViewerStore = create<AfpViewerState>((set, get) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setFile: (name, size, data) =>
    set({
      fileName: name,
      fileSize: size,
      fileData: data,
      status: 'loading',
      errorMessage: null,
    }),

  setPageIndex: (index) =>
    set({
      pageIndex: index,
      totalPages: index.length,
      status: 'ready',
      currentPage: 1,
    }),

  setIndexProgress: (progress, pagesFound) =>
    set({ indexProgress: progress, pagesFound, status: 'indexing' }),

  setCurrentPage: (page) => {
    const { totalPages, currentPage } = get();
    if (page >= 1 && page <= totalPages && page !== currentPage) {
      set({ currentPage: page, isPageLoading: true });
    }
  },

  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(500, zoom)), fitMode: 'none' }),

  zoomIn: () => {
    const { zoom } = get();
    const nextStep = ZOOM_STEPS.find((s) => s > zoom);
    set({ zoom: nextStep ?? Math.min(zoom + 25, 500), fitMode: 'none' });
  },

  zoomOut: () => {
    const { zoom } = get();
    const prevStep = [...ZOOM_STEPS].reverse().find((s) => s < zoom);
    set({ zoom: prevStep ?? Math.max(zoom - 25, 10), fitMode: 'none' });
  },

  setRotation: (rotation) => set({ rotation: rotation % 360 }),

  rotateClockwise: () => {
    const { rotation } = get();
    set({ rotation: (rotation + 90) % 360 });
  },

  setFitMode: (mode) => set({ fitMode: mode }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  toggleElementTree: () => set((s) => ({ elementTreeOpen: !s.elementTreeOpen })),
  toggleElementSelectMode: () => set((s) => ({ elementSelectMode: !s.elementSelectMode })),
  togglePlaceholders: () => set((s) => ({ showPlaceholders: !s.showPlaceholders })),
  toggleExport: () => set((s) => ({ exportOpen: !s.exportOpen })),
  setDocDividerTle: (key: string) => set({ docDividerTle: key }),
  setSelectedElementId: (id) => set({ selectedElementId: id }),
  setSelectedElementOffset: (offset: number | null) => set({ selectedElementOffset: offset }),

  setCurrentPageBitmap: (bitmap) => set({ currentPageBitmap: bitmap, isPageLoading: false }),

  setThumbnail: (page, bitmap) => {
    const { thumbnails } = get();
    const next = new Map(thumbnails);
    next.set(page, bitmap);
    set({ thumbnails: next });
  },

  setIsPageLoading: (loading) => set({ isPageLoading: loading }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchResults: (results) => set({ searchResults: results, currentSearchIndex: results.length > 0 ? 0 : -1 }),

  setCurrentSearchIndex: (index) => set({ currentSearchIndex: index }),

  setError: (message) =>
    set({ errorMessage: message, status: message ? 'error' : get().status }),

  nextPage: () => {
    const { currentPage, totalPages } = get();
    if (currentPage < totalPages) {
      set({ currentPage: currentPage + 1, isPageLoading: true });
    }
  },

  prevPage: () => {
    const { currentPage } = get();
    if (currentPage > 1) {
      set({ currentPage: currentPage - 1, isPageLoading: true });
    }
  },

  goToPage: (page) => {
    const { totalPages, currentPage } = get();
    const clamped = Math.max(1, Math.min(page, totalPages));
    if (clamped === currentPage) return; // already on this page
    set({ currentPage: clamped, isPageLoading: true });
  },

  reset: () => set({ ...initialState, thumbnails: new Map() }),
}));
