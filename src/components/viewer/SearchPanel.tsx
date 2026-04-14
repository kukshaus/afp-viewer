'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { Search, X, ChevronUp, ChevronDown, Loader2, FileText, Tag, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSearchIndex, type SearchHit, type SearchIndexState } from '@/lib/search/search-index';

export function SearchPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [searchType, setSearchType] = useState<'all' | 'text' | 'tle'>('all');
  const [indexState, setIndexState] = useState<SearchIndexState>({
    indexedPages: 0,
    totalPages: 0,
    isComplete: false,
    isIndexing: false,
  });
  const [searchTimeMs, setSearchTimeMs] = useState<number | null>(null);

  const { toggleSearch, goToPage } = useAfpViewer();

  const searchQuery = useAfpViewerStore((s) => s.searchQuery);
  const setSearchQuery = useAfpViewerStore((s) => s.setSearchQuery);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const fileData = useAfpViewerStore((s) => s.fileData);

  // Build index in background when panel opens or file changes
  useEffect(() => {
    if (!fileData || pageIndex.length === 0) return;

    const index = getSearchIndex();

    // Start background indexing
    index.build(fileData, pageIndex, (state) => {
      setIndexState({ ...state });

      // Re-run current search if we have a query and more pages got indexed
      if (searchQuery.trim()) {
        const t0 = performance.now();
        const hits = index.search(searchQuery, searchType);
        setSearchTimeMs(performance.now() - t0);
        setResults(hits);
        setCurrentIndex(hits.length > 0 ? 0 : -1);
      }
    });

    return () => {
      // Don't abort on unmount — keep the index alive for re-opening
    };
  }, [fileData, pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const performSearch = useCallback(
    (query: string, type: 'all' | 'text' | 'tle' = searchType) => {
      if (!query.trim()) {
        setResults([]);
        setCurrentIndex(-1);
        setSearchTimeMs(null);
        return;
      }

      const index = getSearchIndex();
      const t0 = performance.now();
      const hits = index.search(query, type);
      setSearchTimeMs(performance.now() - t0);
      setResults(hits);
      setCurrentIndex(hits.length > 0 ? 0 : -1);
    },
    [searchType],
  );

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      // Shorter debounce since search is now instant
      timerRef.current = setTimeout(() => performSearch(value), 100);
    },
    [performSearch, setSearchQuery],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= results.length) return;
      setCurrentIndex(index);
      goToPage(results[index].pageNumber);
    },
    [results, goToPage],
  );

  const goNext = useCallback(() => {
    if (results.length === 0) return;
    jumpTo((currentIndex + 1) % results.length);
  }, [results, currentIndex, jumpTo]);

  const goPrev = useCallback(() => {
    if (results.length === 0) return;
    jumpTo((currentIndex - 1 + results.length) % results.length);
  }, [results, currentIndex, jumpTo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      }
    },
    [goNext, goPrev],
  );

  const handleTypeChange = useCallback(
    (type: 'all' | 'text' | 'tle') => {
      setSearchType(type);
      if (searchQuery) performSearch(searchQuery, type);
    },
    [searchQuery, performSearch],
  );

  const textCount = results.filter((r) => r.type === 'text').length;
  const tleCount = results.filter((r) => r.type === 'tle').length;
  const filteredResults = results.filter(
    (r) => searchType === 'all' || r.type === searchType,
  );

  const indexPct = indexState.totalPages > 0
    ? Math.round((indexState.indexedPages / indexState.totalPages) * 100)
    : 0;

  return (
    <div className="absolute right-0 top-0 z-50 flex h-full w-96 flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
        <h2 className="text-sm font-semibold">Search</h2>
        <Button variant="ghost" size="sm" onClick={toggleSearch}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Index status bar */}
      {!indexState.isComplete && (
        <div className="border-b border-[hsl(var(--border))] px-3 py-1.5">
          <div className="flex items-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              Building search index... {indexState.indexedPages}/{indexState.totalPages} pages ({indexPct}%)
            </span>
          </div>
          <div className="mt-1 h-1 w-full rounded-full bg-[hsl(var(--muted))]">
            <div
              className="h-full rounded-full bg-[hsl(var(--primary))] transition-all duration-300"
              style={{ width: `${indexPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Search input */}
      <div className="flex items-center gap-1 border-b border-[hsl(var(--border))] px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search text or TLE fields..."
          value={searchQuery}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          className="h-7 flex-1 bg-transparent text-sm text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
        />
        {!indexState.isIndexing && results.length > 0 && (
          <div className="flex items-center gap-0.5 shrink-0">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {currentIndex + 1}/{results.length}
            </span>
            <button onClick={goPrev} className="rounded p-0.5 hover:bg-[hsl(var(--accent))]">
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button onClick={goNext} className="rounded p-0.5 hover:bg-[hsl(var(--accent))]">
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Type filter tabs */}
      <div className="flex items-center border-b border-[hsl(var(--border))] px-2 py-1 gap-1">
        {(['all', 'text', 'tle'] as const).map((t) => (
          <button
            key={t}
            onClick={() => handleTypeChange(t)}
            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              searchType === t
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]'
            }`}
          >
            {t === 'all'
              ? `All (${results.length})`
              : t === 'text'
                ? `Text (${textCount})`
                : `TLE (${tleCount})`}
          </button>
        ))}
        {searchTimeMs !== null && searchQuery.trim() && (
          <span className="ml-auto flex items-center gap-0.5 text-[9px] text-[hsl(var(--muted-foreground))]">
            <Zap className="h-2.5 w-2.5" />
            {searchTimeMs < 1 ? '<1' : searchTimeMs.toFixed(0)}ms
          </span>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {filteredResults.map((result, idx) => {
          const globalIdx = results.indexOf(result);
          return (
            <button
              key={`${result.pageNumber}-${result.type}-${result.matchIndex}-${idx}`}
              onClick={() => jumpTo(globalIdx)}
              className={`w-full border-b border-[hsl(var(--border))]/30 px-3 py-2 text-left transition-colors ${
                globalIdx === currentIndex ? 'bg-[hsl(var(--primary))]/10' : 'hover:bg-[hsl(var(--accent))]'
              }`}
            >
              <div className="flex items-center gap-2">
                {result.type === 'tle' ? (
                  <Tag className="h-3 w-3 shrink-0 text-orange-500" />
                ) : (
                  <FileText className="h-3 w-3 shrink-0 text-blue-500" />
                )}
                <span className="text-[10px] font-medium text-[hsl(var(--primary))]">
                  Page {result.pageNumber}
                </span>
                {result.tleKey && (
                  <span className="rounded bg-orange-100 px-1 text-[9px] font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                    {result.tleKey}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-[hsl(var(--foreground))]">
                {result.excerpt}
              </p>
            </button>
          );
        })}

        {searchQuery && results.length === 0 && !indexState.isIndexing && (
          <div className="flex flex-col items-center py-8">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">No results found</p>
          </div>
        )}

        {searchQuery && results.length === 0 && indexState.isIndexing && (
          <div className="flex flex-col items-center py-8 gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--muted-foreground))]" />
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Indexing pages... results will appear as pages are indexed
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
