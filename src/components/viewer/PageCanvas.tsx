'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { Loader2, Copy, Check, Trash2, Save, CheckSquare, Square } from 'lucide-react';
import type { PageRenderTree } from '@/lib/afp/types';
import { reassembleAfp } from '@/lib/afp/afp-page-manager';
import { downloadBlob } from '@/lib/afp/afp-cutter';

const RENDER_DPI = 150;
const RESOLUTION = 1440;

export function PageCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [pageCanvas, setPageCanvas] = useState<HTMLCanvasElement | null>(null);
  const [renderTree, setRenderTree] = useState<PageRenderTree | null>(null);

  const {
    currentPage,
    zoom,
    rotation,
    fitMode,
    isPageLoading,
    pageIndex,
    fileData,
    setCurrentPageBitmap,
    setIsPageLoading,
    setZoom,
  } = useAfpViewer();

  const currentPageBitmap = useAfpViewerStore((s) => s.currentPageBitmap);
  const searchQuery = useAfpViewerStore((s) => s.searchQuery);
  const searchResults = useAfpViewerStore((s) => s.searchResults);
  const currentSearchIndex = useAfpViewerStore((s) => s.currentSearchIndex);
  const elementSelectMode = useAfpViewerStore((s) => s.elementSelectMode);
  const [selectedRun, setSelectedRun] = useState<{ x: number; y: number; w: number; h: number; text: string; fontSize: number; resourceName?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const hasAutoFit = useRef(false);

  const renderCurrentPage = useCallback(async () => {
    if (!fileData || !pageIndex.length || currentPage < 1) return;

    const entry = pageIndex[currentPage - 1];
    if (!entry) return;

    setRenderError(null);
    setIsPageLoading(true);

    try {
      const { parsePage } = await import('@/lib/afp/page-parser');
      const { renderPage } = await import('@/lib/renderer/compositor');

      const tree = parsePage(fileData, entry.byteOffset, entry.byteLength);
      setRenderTree(tree);
      const showPlaceholders = useAfpViewerStore.getState().showPlaceholders;
      const canvas = await renderPage(tree, RENDER_DPI, 1.0, showPlaceholders);
      setPageCanvas(canvas as HTMLCanvasElement);
      setCurrentPageBitmap(canvas as HTMLCanvasElement);

      if (!hasAutoFit.current && containerRef.current) {
        hasAutoFit.current = true;
        const container = containerRef.current;
        const containerW = container.clientWidth - 40;
        const containerH = container.clientHeight - 40;
        const scaleX = containerW / canvas.width;
        const scaleY = containerH / canvas.height;
        const fitZoom = Math.min(scaleX, scaleY, 1.0);
        setZoom(Math.round(fitZoom * 100));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to render page';
      setRenderError(message);
      setCurrentPageBitmap(null);
    } finally {
      setIsPageLoading(false);
    }
  }, [currentPage, fileData, pageIndex, setCurrentPageBitmap, setIsPageLoading, setZoom]);

  useEffect(() => {
    setSelectedRun(null); // clear inspector selection on page change
    setCopied(false);
    renderCurrentPage();
  }, [renderCurrentPage]);

  // Reset copied state whenever the selection changes
  useEffect(() => {
    setCopied(false);
  }, [selectedRun]);

  const handleCopy = useCallback(async () => {
    if (!selectedRun?.text) return;
    try {
      await navigator.clipboard.writeText(selectedRun.text);
      setCopied(true);
      // Reset back to "Copy" after 1.5s
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  }, [selectedRun]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const source = pageCanvas || currentPageBitmap;
    if (!canvas || !source) return;

    const w = source instanceof HTMLCanvasElement ? source.width : (source as ImageBitmap).width;
    const h = source instanceof HTMLCanvasElement ? source.height : (source as ImageBitmap).height;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source as CanvasImageSource, 0, 0);
  }, [pageCanvas, currentPageBitmap]);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;
    if (fitMode === 'none') return;
    const containerW = containerRef.current.clientWidth - 40;
    const containerH = containerRef.current.clientHeight - 40;
    const canvasW = canvasRef.current.width;
    const canvasH = canvasRef.current.height;
    if (canvasW === 0 || canvasH === 0) return;
    if (fitMode === 'width') {
      setZoom(Math.round((containerW / canvasW) * 100));
    } else if (fitMode === 'page') {
      setZoom(Math.round(Math.min(containerW / canvasW, containerH / canvasH) * 100));
    }
  }, [fitMode, setZoom]);

  const setSelectedElementOffset = useAfpViewerStore((s) => s.setSelectedElementOffset);

  // Handle element inspector clicks — detects text, images, graphics, barcodes
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!elementSelectMode || !renderTree) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleRatio = canvas.width / rect.width;
    const clickX = (e.clientX - rect.left) * scaleRatio;
    const clickY = (e.clientY - rect.top) * scaleRatio;

    const resolution = renderTree.resolution > 0 ? renderTree.resolution : 1440;
    const sf = RENDER_DPI / resolution;

    let bestRun: typeof selectedRun = null;
    let bestDist = Infinity;
    let textObjIndex = 0;
    let bestTextObjIndex = -1;

    for (const obj of renderTree.objects) {
      const objPxX = obj.x * sf;
      const objPxY = obj.y * sf;
      const objPxW = Math.max(obj.width * sf, 20);
      const objPxH = Math.max(obj.height * sf, 20);

      if (obj.kind === 'text' && obj.text) {
        for (const run of obj.text.runs) {
          if (!run.text.trim()) continue;
          const rx = run.x * sf;
          const ry = run.y * sf;
          const rw = run.text.length * run.fontSize * 0.6 * (RENDER_DPI / 72) * 0.92;
          const rh = run.fontSize * 1.3 * (RENDER_DPI / 72) * 0.92;
          if (clickX >= rx - 5 && clickX <= rx + rw + 5 &&
              clickY >= ry - rh - 5 && clickY <= ry + 5) {
            const dist = Math.abs(clickX - (rx + rw / 2)) + Math.abs(clickY - (ry - rh / 2));
            if (dist < bestDist) {
              bestDist = dist;
              bestRun = { x: rx, y: ry - rh, w: rw, h: rh, text: run.text, fontSize: run.fontSize };
              bestTextObjIndex = textObjIndex;
            }
          }
        }
        textObjIndex++;
      } else if (obj.kind === 'image' || obj.kind === 'graphics' || obj.kind === 'barcode') {
        // Hit-test for non-text objects using their bounding box
        if (clickX >= objPxX - 5 && clickX <= objPxX + objPxW + 5 &&
            clickY >= objPxY - 5 && clickY <= objPxY + objPxH + 5) {
          const dist = Math.abs(clickX - (objPxX + objPxW / 2)) + Math.abs(clickY - (objPxY + objPxH / 2));
          if (dist < bestDist) {
            bestDist = dist;
            const label = obj.kind === 'image' ? 'Image' :
                          obj.kind === 'graphics' ? 'Graphics (GOCA)' : 'Barcode';
            bestRun = {
              x: objPxX, y: objPxY, w: objPxW, h: objPxH,
              text: label,
              fontSize: 0,
              resourceName: obj.resourceName,
            };
          }
        }
      }
    }

    setSelectedRun(bestRun);

    // Signal the element tree to find and select the matching node by offset
    if (bestRun && fileData && pageIndex.length > 0) {
      const entry = pageIndex[currentPage - 1];
      if (entry) {
        // Find the structured field in the page that matches this object
        const typeMap: Record<string, string[]> = {
          'Image': ['D3A8C5', 'D3A8FB', 'D3A892', 'D3AF5F'],
          'Graphics (GOCA)': ['D3A8C3', 'D3AF5F'],
          'Barcode': ['D3A8EB'],
        };
        // For text clicks, search for BPT (standard and alternate)
        const isText = !typeMap[bestRun.text];
        const targetTypes = typeMap[bestRun.text] || ['D3A87B', 'D3A89B'];
        // Scan the page data for the matching structured field
        const view = new DataView(fileData);
        let off = entry.byteOffset;
        const end = entry.byteOffset + entry.byteLength;
        let matchCount = 0;
        // For text: find the N-th BPT matching the clicked text object index
        const targetMatch = isText ? bestTextObjIndex : 0;
        while (off < end - 9) {
          if (view.getUint8(off) !== 0x5A) { off++; continue; }
          const len = view.getUint16(off + 1, false);
          if (len < 6 || len > 32766) { off++; continue; }
          const tid = view.getUint8(off + 3).toString(16).toUpperCase().padStart(2, '0') +
                      view.getUint8(off + 4).toString(16).toUpperCase().padStart(2, '0') +
                      view.getUint8(off + 5).toString(16).toUpperCase().padStart(2, '0');
          if (targetTypes.includes(tid)) {
            if (matchCount === targetMatch) {
              setSelectedElementOffset(off);
              break;
            }
            matchCount++;
          }
          const next = off + 1 + len;
          if (next <= off) break;
          off = next;
        }
      }
    }
  }, [elementSelectMode, renderTree, fileData, pageIndex, currentPage, setSelectedElementOffset]);

  // Build highlight overlays from the render tree
  const scaleFactor = RENDER_DPI / RESOLUTION;
  const scale = zoom / 100;
  const highlights = buildHighlights(renderTree, searchQuery, scaleFactor);
  const activeHighlightIndex = searchResults.length > 0 && currentSearchIndex >= 0
    ? currentSearchIndex
    : -1;

  return (
    <div
      ref={containerRef}
      className="relative flex flex-1 items-start justify-center overflow-auto bg-[hsl(var(--muted))] p-5"
    >
      {isPageLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[hsl(var(--muted))]/80">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-[hsl(var(--primary))]" />
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Rendering page {currentPage}...
            </p>
          </div>
        </div>
      )}

      {/* Page edit floating bar */}
      <PageEditBar />

      {renderError && !isPageLoading && (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium text-[hsl(var(--destructive))]">Render Error</p>
          <p className="max-w-sm text-xs text-[hsl(var(--muted-foreground))]">{renderError}</p>
        </div>
      )}

      {!renderError && (
        <div
          style={{
            transform: `scale(${scale})${rotation ? ` rotate(${rotation}deg)` : ''}`,
            transformOrigin: 'top center',
            transition: 'transform 0.15s ease',
            position: 'relative',
          }}
        >
          <canvas
            ref={canvasRef}
            className={`shadow-lg ${elementSelectMode ? 'cursor-crosshair' : ''}`}
            style={{ imageRendering: zoom > 200 ? 'pixelated' : 'auto' }}
            onClick={handleCanvasClick}
          />
          {/* Selected element highlight (inspector mode) */}
          {selectedRun && elementSelectMode && (
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute"
                style={{
                  left: `${selectedRun.x}px`,
                  top: `${selectedRun.y}px`,
                  width: `${selectedRun.w}px`,
                  height: `${selectedRun.h}px`,
                  backgroundColor: 'rgba(59, 130, 246, 0.2)',
                  border: '2px solid rgba(59, 130, 246, 0.8)',
                  borderRadius: '2px',
                }}
              />
              {/* Info tooltip — only the tooltip itself accepts pointer events */}
              <div
                className="pointer-events-auto absolute flex items-start gap-2 rounded bg-[hsl(var(--foreground))] px-2 py-1 text-[10px] text-[hsl(var(--background))] shadow-lg"
                style={{
                  left: `${selectedRun.x}px`,
                  top: `${selectedRun.y + selectedRun.h + 4}px`,
                  maxWidth: '320px',
                  zIndex: 20,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{selectedRun.text}</p>
                  {selectedRun.resourceName && (
                    <p className="mt-0.5 font-mono opacity-90">
                      {selectedRun.resourceName}
                    </p>
                  )}
                  <p className="mt-0.5 opacity-70">
                    X: {Math.round(selectedRun.x)}px | Y: {Math.round(selectedRun.y)}px
                    {selectedRun.fontSize > 0 ? ` | Size: ${selectedRun.fontSize}pt` : ` | ${Math.round(selectedRun.w)}x${Math.round(selectedRun.h)}px`}
                  </p>
                </div>
                {selectedRun.fontSize > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                    className="shrink-0 rounded p-1 hover:bg-[hsl(var(--background))]/20 active:bg-[hsl(var(--background))]/30"
                    title={copied ? 'Copied!' : 'Copy to clipboard'}
                    aria-label="Copy text to clipboard"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-green-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Search highlights overlay */}
          {highlights.length > 0 && (
            <div className="pointer-events-none absolute inset-0">
              {highlights.map((h, i) => (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: `${h.x}px`,
                    top: `${h.y}px`,
                    width: `${h.w}px`,
                    height: `${h.h}px`,
                    backgroundColor:
                      i === activeHighlightIndex
                        ? 'rgba(255, 120, 0, 0.35)'
                        : 'rgba(255, 230, 0, 0.3)',
                    border:
                      i === activeHighlightIndex
                        ? '2px solid rgba(255, 120, 0, 0.8)'
                        : '1px solid rgba(200, 180, 0, 0.5)',
                    borderRadius: '2px',
                    pointerEvents: 'none',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!currentPageBitmap && !pageCanvas && !isPageLoading && !renderError && (
        <div className="flex flex-col items-center gap-2">
          <div className="h-[600px] w-[450px] animate-pulse rounded bg-[hsl(var(--border))]" />
        </div>
      )}
    </div>
  );
}

interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

function buildHighlights(
  tree: PageRenderTree | null,
  query: string,
  scaleFactor: number,
): Highlight[] {
  if (!tree || !query.trim()) return [];

  const lowerQuery = query.toLowerCase();
  const highlights: Highlight[] = [];

  for (const obj of tree.objects) {
    if (obj.kind !== 'text' || !obj.text) continue;

    for (const run of obj.text.runs) {
      if (!run.text || run.text.length === 0) continue;
      if (!run.text.toLowerCase().includes(lowerQuery)) continue;

      // Calculate position on canvas
      const x = run.x * scaleFactor;
      const y = (run.y - run.fontSize * 1.2 * 10) * scaleFactor; // adjust for baseline
      const charWidth = run.fontSize * 0.6 * (150 / 72); // approximate
      const w = run.text.length * charWidth;
      const h = run.fontSize * 1.4 * (150 / 72);

      highlights.push({
        x: Math.max(0, x),
        y: Math.max(0, y),
        w: Math.max(10, w),
        h: Math.max(8, h),
      });
    }
  }

  return highlights;
}

/** Floating action bar for the current page when page edit mode is active. */
function PageEditBar() {
  const pageEditMode = useAfpViewerStore((s) => s.pageEditMode);
  const selectedPages = useAfpViewerStore((s) => s.selectedPages);
  const currentPage = useAfpViewerStore((s) => s.currentPage);
  const totalPages = useAfpViewerStore((s) => s.pageIndex).length;
  const fileData = useAfpViewerStore((s) => s.fileData);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const fileName = useAfpViewerStore((s) => s.fileName);

  if (!pageEditMode || !fileData || totalPages === 0) return null;

  const isSelected = selectedPages.has(currentPage);

  const toggleCurrent = () => {
    const next = new Set(selectedPages);
    if (next.has(currentPage)) next.delete(currentPage);
    else next.add(currentPage);
    useAfpViewerStore.setState({ selectedPages: next });
  };

  const deleteCurrent = () => {
    const keepOrder: number[] = [];
    for (let i = 0; i < pageIndex.length; i++) {
      if (i + 1 !== currentPage) keepOrder.push(i);
    }
    if (keepOrder.length === 0) return;
    const blob = reassembleAfp(fileData, pageIndex, keepOrder);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_edited.afp`);
  };

  const extractCurrent = () => {
    const blob = reassembleAfp(fileData, pageIndex, [currentPage - 1]);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_page${currentPage}.afp`);
  };

  const deleteSelected = () => {
    if (selectedPages.size === 0) return;
    const keepOrder: number[] = [];
    for (let i = 0; i < pageIndex.length; i++) {
      if (!selectedPages.has(i + 1)) keepOrder.push(i);
    }
    if (keepOrder.length === 0) return;
    const blob = reassembleAfp(fileData, pageIndex, keepOrder);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_edited.afp`);
  };

  const extractSelected = () => {
    if (selectedPages.size === 0) return;
    const order = Array.from(selectedPages).sort((a, b) => a - b).map((p) => p - 1);
    const blob = reassembleAfp(fileData, pageIndex, order);
    const stem = (fileName || 'document').replace(/\.afp$/i, '');
    downloadBlob(blob, `${stem}_extracted.afp`);
  };

  return (
    <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1.5 shadow-lg">
        {/* Toggle select current page */}
        <button
          onClick={toggleCurrent}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            isSelected
              ? 'bg-[hsl(var(--primary))]/15 text-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
          }`}
          title={isSelected ? 'Deselect this page' : 'Select this page'}
        >
          {isSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
          Page {currentPage}
        </button>

        <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />

        {/* Current page actions */}
        <button
          onClick={extractCurrent}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
          title="Extract this page as AFP"
        >
          <Save className="h-3.5 w-3.5" /> Extract
        </button>
        <button
          onClick={deleteCurrent}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          title="Download document without this page"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>

        {/* Batch actions when pages are selected */}
        {selectedPages.size > 0 && (
          <>
            <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />
            <span className="text-[10px] font-medium text-[hsl(var(--primary))]">
              {selectedPages.size} sel.
            </span>
            <button
              onClick={extractSelected}
              className="flex items-center gap-1 rounded bg-[hsl(var(--primary))] px-2 py-1 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
              title="Extract all selected pages"
            >
              <Save className="h-3 w-3" />
            </button>
            <button
              onClick={deleteSelected}
              className="flex items-center gap-1 rounded bg-[hsl(var(--destructive))] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
              title="Remove all selected pages"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
