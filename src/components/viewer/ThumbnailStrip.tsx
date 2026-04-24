'use client';

import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { reassembleAfp } from '@/lib/afp/afp-page-manager';
import { downloadBlob } from '@/lib/afp/afp-cutter';
import { FileText, FolderOpen, Trash2, Save, CheckSquare, ArrowUpDown, X } from 'lucide-react';

interface DocGroup {
  label: string;
  startPage: number;
  endPage: number;
}

const ITEM_HEIGHT = 42;
const DOC_HEADER_HEIGHT = 32;

function decodeEbcdicKey(view: DataView, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len; i++) {
    const b = view.getUint8(i);
    if (b === 0x40 || b === 0x6D) s += '_';
    else if (b >= 0xC1 && b <= 0xC9) s += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) s += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) s += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0xF0 && b <= 0xF9) s += String.fromCharCode(48 + b - 0xF0);
    else if (b >= 0x81 && b <= 0x89) s += String.fromCharCode(97 + b - 0x81);
    else if (b >= 0x91 && b <= 0x99) s += String.fromCharCode(106 + b - 0x91);
    else if (b >= 0xA2 && b <= 0xA9) s += String.fromCharCode(115 + b - 0xA2);
    else if (b === 0x7D) s += "'";
    else if (b === 0x60) s += '-';
  }
  return s.replace(/_+$/, '').trim();
}

export function ThumbnailStrip() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { currentPage, totalPages, goToPage } = useAfpViewer();
  const fileData = useAfpViewerStore((s) => s.fileData);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const docDividerTle = useAfpViewerStore((s) => s.docDividerTle);
  const pageEditMode = useAfpViewerStore((s) => s.pageEditMode);
  const selectedPages = useAfpViewerStore((s) => s.selectedPages);
  const [docGroups, setDocGroups] = useState<DocGroup[]>([]);
  const [moveTarget, setMoveTarget] = useState<string>('');
  const lastClickedRef = useRef<number | null>(null);

  // Compute document groups asynchronously (batched to avoid UI freeze)
  useEffect(() => {
    if (!docDividerTle || !fileData || !pageIndex.length) {
      setDocGroups([]);
      return;
    }

    const view = new DataView(fileData);
    const groups: DocGroup[] = [];
    let currentDocLabel = '';
    let currentDocStart = 1;
    let cancelled = false;

    let p = 0;
    function processBatch() {
      if (cancelled) return;
      const batchEnd = Math.min(p + 50, pageIndex.length);

      for (; p < batchEnd; p++) {
        const entry = pageIndex[p];
        let scanStart = entry.byteOffset;
        const prevEnd = p > 0 ? pageIndex[p - 1].byteOffset + pageIndex[p - 1].byteLength : 0;
        scanStart = Math.max(scanStart - 5000, prevEnd);
        let off = scanStart;
        const end = entry.byteOffset + entry.byteLength;

        while (off < end - 9) {
          if (view.getUint8(off) !== 0x5A) { off++; continue; }
          const len = view.getUint16(off + 1, false);
          if (len < 6 || len > 32766) { off++; continue; }

          if (view.getUint8(off + 3) === 0xD3 && view.getUint8(off + 4) === 0xA0 && view.getUint8(off + 5) === 0x90) {
            const dl = len - 8;
            let tp = off + 9;
            const tEnd = off + 9 + dl;
            let tleKey = '';
            let tleValue = '';
            while (tp + 4 < tEnd) {
              const tLen = view.getUint8(tp);
              const tId = view.getUint8(tp + 1);
              if (tLen < 2 || tp + tLen > tEnd) break;
              if (tId === 0x02 && tLen > 4) tleKey = decodeEbcdicKey(view, tp + 4, tLen - 4);
              if (tId === 0x36 && tLen > 4) tleValue = decodeEbcdicKey(view, tp + 4, tLen - 4);
              tp += tLen;
            }
            if (tleKey === docDividerTle && tleValue) {
              const pageNum = p + 1;
              if (currentDocLabel && pageNum > currentDocStart) {
                groups.push({ label: currentDocLabel, startPage: currentDocStart, endPage: pageNum - 1 });
              }
              currentDocLabel = tleValue;
              currentDocStart = pageNum;
            }
          }

          const next = off + 1 + view.getUint16(off + 1, false);
          if (next <= off) break;
          off = next;
        }
      }

      if (p < pageIndex.length) {
        requestAnimationFrame(processBatch);
      } else {
        if (currentDocLabel) {
          groups.push({ label: currentDocLabel, startPage: currentDocStart, endPage: pageIndex.length });
        }
        setDocGroups(groups);
      }
    }
    processBatch();
    return () => { cancelled = true; };
  }, [docDividerTle, fileData, pageIndex]);

  const items = useMemo(() => {
    if (docGroups.length === 0) {
      return Array.from({ length: totalPages }, (_, i) => ({
        type: 'page' as const,
        pageNum: i + 1,
        height: ITEM_HEIGHT,
      }));
    }

    const result: { type: 'doc' | 'page'; pageNum: number; label?: string; docIdx?: number; height: number }[] = [];
    for (let g = 0; g < docGroups.length; g++) {
      const group = docGroups[g];
      result.push({ type: 'doc', pageNum: group.startPage, label: group.label, docIdx: g + 1, height: DOC_HEADER_HEIGHT });
      for (let p = group.startPage; p <= group.endPage; p++) {
        result.push({ type: 'page', pageNum: p, height: ITEM_HEIGHT });
      }
    }
    return result;
  }, [docGroups, totalPages]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (i) => items[i]?.height ?? ITEM_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    if (currentPage >= 1) {
      const idx = items.findIndex(item => item.type === 'page' && item.pageNum === currentPage);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
    }
  }, [currentPage, virtualizer, items]);

  // ── Selection helpers ──────────────────────────────────────────────────

  const togglePage = useCallback((pageNum: number, e: React.MouseEvent) => {
    if (!pageEditMode) {
      goToPage(pageNum);
      return;
    }

    const prev = useAfpViewerStore.getState().selectedPages;

    if (e.shiftKey && lastClickedRef.current !== null) {
      // Range select
      const from = Math.min(lastClickedRef.current, pageNum);
      const to = Math.max(lastClickedRef.current, pageNum);
      const next = new Set(prev);
      for (let p = from; p <= to; p++) next.add(p);
      useAfpViewerStore.setState({ selectedPages: next });
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle single
      const next = new Set(prev);
      if (next.has(pageNum)) next.delete(pageNum);
      else next.add(pageNum);
      useAfpViewerStore.setState({ selectedPages: next });
    } else {
      // Single select (replace)
      useAfpViewerStore.setState({ selectedPages: new Set([pageNum]) });
    }
    lastClickedRef.current = pageNum;
    goToPage(pageNum);
  }, [pageEditMode, goToPage]);

  const selectAll = useCallback(() => {
    const all = new Set<number>();
    for (let i = 1; i <= totalPages; i++) all.add(i);
    useAfpViewerStore.setState({ selectedPages: all });
  }, [totalPages]);

  const selectNone = useCallback(() => {
    useAfpViewerStore.setState({ selectedPages: new Set() });
  }, []);

  const invertSelection = useCallback(() => {
    const prev = useAfpViewerStore.getState().selectedPages;
    const next = new Set<number>();
    for (let i = 1; i <= totalPages; i++) {
      if (!prev.has(i)) next.add(i);
    }
    useAfpViewerStore.setState({ selectedPages: next });
  }, [totalPages]);

  // Delete selected = keep everything except selected
  const deleteSelected = useCallback(() => {
    if (!fileData || !pageIndex.length || selectedPages.size === 0) return;
    const keepOrder: number[] = [];
    for (let i = 0; i < pageIndex.length; i++) {
      if (!selectedPages.has(i + 1)) keepOrder.push(i);
    }
    if (keepOrder.length === 0) return;
    const blob = reassembleAfp(fileData, pageIndex, keepOrder);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_edited.afp`);
  }, [fileData, pageIndex, selectedPages, fileName]);

  // Extract selected = keep only selected, in original order
  const extractSelected = useCallback(() => {
    if (!fileData || !pageIndex.length || selectedPages.size === 0) return;
    const order = Array.from(selectedPages).sort((a, b) => a - b).map((p) => p - 1);
    const blob = reassembleAfp(fileData, pageIndex, order);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_extracted.afp`);
  }, [fileData, pageIndex, selectedPages, fileName]);

  // Move selected pages to a specific position
  const moveSelected = useCallback(() => {
    if (!fileData || !pageIndex.length || selectedPages.size === 0) return;
    const target = parseInt(moveTarget, 10);
    if (isNaN(target) || target < 1 || target > totalPages) return;

    // Build new order: all pages with selected ones removed, then inserted at target
    const sel = Array.from(selectedPages).sort((a, b) => a - b).map((p) => p - 1);
    const selSet = new Set(sel);
    const remaining: number[] = [];
    for (let i = 0; i < pageIndex.length; i++) {
      if (!selSet.has(i)) remaining.push(i);
    }
    // Insert at position (target-1, clamped)
    const insertAt = Math.min(target - 1, remaining.length);
    remaining.splice(insertAt, 0, ...sel);

    const blob = reassembleAfp(fileData, pageIndex, remaining);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_reordered.afp`);
  }, [fileData, pageIndex, selectedPages, moveTarget, totalPages, fileName]);

  const toggleEditMode = useCallback(() => {
    const next = !pageEditMode;
    useAfpViewerStore.setState({
      pageEditMode: next,
      selectedPages: next ? new Set<number>() : new Set<number>(),
    });
  }, [pageEditMode]);

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-[hsl(var(--border))] px-2 py-1.5">
        {docGroups.length > 0 ? (
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{docGroups.length} Documents</span>
        ) : (
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{totalPages} Pages</span>
        )}
        <button
          onClick={toggleEditMode}
          className={`rounded p-1 transition-colors ${
            pageEditMode
              ? 'bg-[hsl(var(--primary))]/15 text-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
          }`}
          title={pageEditMode ? 'Exit page edit mode' : 'Page edit mode'}
        >
          {pageEditMode ? <X className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Selection toolbar */}
      {pageEditMode && (
        <div className="shrink-0 border-b border-[hsl(var(--border))] px-2 py-1 space-y-1">
          <div className="flex items-center gap-1 text-[10px]">
            <button onClick={selectAll} className="rounded px-1.5 py-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">All</button>
            <button onClick={selectNone} className="rounded px-1.5 py-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">None</button>
            <button onClick={invertSelection} className="rounded px-1.5 py-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">Invert</button>
            <span className="ml-auto font-medium text-[hsl(var(--primary))]">
              {selectedPages.size > 0 ? `${selectedPages.size} sel.` : ''}
            </span>
          </div>
        </div>
      )}

      {/* Thumbnail list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const item = items[vItem.index];
            if (!item) return null;

            if (item.type === 'doc') {
              return (
                <div
                  key={'doc-' + vItem.index}
                  className="absolute left-0 right-0 flex items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2"
                  style={{ top: `${vItem.start}px`, height: `${vItem.size}px` }}
                >
                  <FolderOpen className="h-3 w-3 shrink-0 text-[hsl(var(--primary))]" />
                  <span className="truncate text-[10px] font-semibold text-[hsl(var(--foreground))]">
                    {item.docIdx}. {item.label}
                  </span>
                </div>
              );
            }

            const isActive = item.pageNum === currentPage;
            const isSelected = selectedPages.has(item.pageNum);
            return (
              <button
                key={item.pageNum}
                onClick={(e) => togglePage(item.pageNum, e)}
                className={`absolute left-0 right-0 flex items-center gap-2 px-2 py-2 text-left transition-colors ${
                  isSelected
                    ? 'bg-[hsl(var(--primary))]/15 ring-1 ring-inset ring-[hsl(var(--primary))]'
                    : isActive
                      ? 'bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                      : 'hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]'
                }`}
                style={{ top: `${vItem.start}px`, height: `${vItem.size}px` }}
              >
                {pageEditMode && (
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    isSelected
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                      : 'border-[hsl(var(--border))]'
                  }`}>
                    {isSelected ? '✓' : ''}
                  </span>
                )}
                <FileText className={`h-4 w-4 shrink-0 ${isActive ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} />
                <span className={`text-sm font-medium ${isActive ? 'text-[hsl(var(--primary))]' : ''}`}>
                  Page {item.pageNum}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Action bar — visible when pages are selected */}
      {pageEditMode && selectedPages.size > 0 && (
        <div className="shrink-0 border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-2 space-y-1.5">
          <p className="text-[10px] font-medium text-[hsl(var(--foreground))]">
            {selectedPages.size} of {totalPages} pages selected
          </p>

          <div className="flex gap-1">
            <button
              onClick={deleteSelected}
              className="flex flex-1 items-center justify-center gap-1 rounded bg-[hsl(var(--destructive))] px-2 py-1 text-[10px] font-medium text-white hover:opacity-90"
              title="Download document without selected pages"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
            <button
              onClick={extractSelected}
              className="flex flex-1 items-center justify-center gap-1 rounded bg-[hsl(var(--primary))] px-2 py-1 text-[10px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
              title="Download only selected pages as new AFP"
            >
              <Save className="h-3 w-3" /> Extract
            </button>
          </div>

          {/* Move to position */}
          <div className="flex items-center gap-1">
            <ArrowUpDown className="h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
            <input
              type="number"
              min={1}
              max={totalPages}
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              placeholder="Move to pos."
              className="h-6 w-20 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-1.5 text-[10px] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
            />
            <button
              onClick={moveSelected}
              disabled={!moveTarget}
              className="rounded bg-[hsl(var(--accent))] px-2 py-1 text-[10px] font-medium text-[hsl(var(--foreground))] hover:opacity-90 disabled:opacity-40"
            >
              Move
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
