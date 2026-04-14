'use client';

import { useRef, useEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { FileText, FolderOpen } from 'lucide-react';

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
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const docDividerTle = useAfpViewerStore((s) => s.docDividerTle);
  const [docGroups, setDocGroups] = useState<DocGroup[]>([]);

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
        // Scan backwards from page start to find the BPG (which may precede the stored offset)
        // TLEs can be between BPG and the first BRS within the page
        let scanStart = entry.byteOffset;
        const prevEnd = p > 0 ? pageIndex[p - 1].byteOffset + pageIndex[p - 1].byteLength : 0;
        // Look up to 5000 bytes before the stored offset for TLEs
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
            let key = '', value = '';
            while (tp + 4 < tEnd) {
              const tLen = view.getUint8(tp);
              const tId = view.getUint8(tp + 1);
              if (tLen < 2 || tp + tLen > tEnd) break;
              if (tId === 0x02 && tLen > 4) key = decodeEbcdicKey(view, tp + 4, tLen - 4);
              if (tId === 0x36 && tLen > 4) value = decodeEbcdicKey(view, tp + 4, tLen - 4);
              tp += tLen;
            }

            if (key === docDividerTle) {
              const label = value || 'Doc ' + (groups.length + 1);
              if (label !== currentDocLabel) {
                if (currentDocLabel && currentDocStart <= p) {
                  groups.push({ label: currentDocLabel, startPage: currentDocStart, endPage: p });
                }
                currentDocLabel = label;
                currentDocStart = p + 1;
              }
              break; // found divider for this page
            }
          }

          const next = off + 1 + len;
          if (next <= off) break;
          off = next;
        }
      }

      if (p < pageIndex.length) {
        setTimeout(processBatch, 0);
      } else {
        if (currentDocLabel) {
          groups.push({ label: currentDocLabel, startPage: currentDocStart, endPage: pageIndex.length });
        }
        if (!cancelled) setDocGroups([...groups]);
      }
    }

    processBatch();
    return () => { cancelled = true; };
  }, [docDividerTle, fileData, pageIndex]);

  // Build flat list: doc headers + pages
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

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {docGroups.length > 0 && (
        <div className="shrink-0 border-b border-[hsl(var(--border))] px-3 py-1.5">
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{docGroups.length} Documents</span>
        </div>
      )}
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
            return (
              <button
                key={item.pageNum}
                onClick={() => goToPage(item.pageNum)}
                className={`absolute left-0 right-0 flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isActive
                    ? 'bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                    : 'hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]'
                }`}
                style={{ top: `${vItem.start}px`, height: `${vItem.size}px` }}
              >
                <FileText className={`h-4 w-4 shrink-0 ${isActive ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} />
                <span className={`text-sm font-medium ${isActive ? 'text-[hsl(var(--primary))]' : ''}`}>
                  Page {item.pageNum}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
