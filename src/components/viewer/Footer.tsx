'use client';

import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RectangleHorizontal,
  RotateCw,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export function Footer() {
  const {
    nextPage,
    prevPage,
    zoomIn,
    zoomOut,
    rotateClockwise,
    setFitMode,
  } = useAfpViewer();

  const currentPage = useAfpViewerStore((s) => s.currentPage);
  const totalPages = useAfpViewerStore((s) => s.totalPages);
  const zoom = useAfpViewerStore((s) => s.zoom);

  return (
    <footer className="flex h-10 shrink-0 items-center justify-between border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4">
      {/* Left: page navigation */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={prevPage}
          disabled={currentPage <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <span className="min-w-[100px] text-center text-xs text-[hsl(var(--foreground))]">
          Page {currentPage} of {totalPages}
        </span>

        <Button
          variant="ghost"
          size="sm"
          onClick={nextPage}
          disabled={currentPage >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Right: zoom and view controls */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={zoomOut}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>

        <span className="min-w-[48px] text-center text-xs text-[hsl(var(--foreground))]">
          {zoom}%
        </span>

        <Button
          variant="ghost"
          size="sm"
          onClick={zoomIn}
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFitMode('width')}
          aria-label="Fit to width"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFitMode('page')}
          aria-label="Fit to page"
        >
          <RectangleHorizontal className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={rotateClockwise}
          aria-label="Rotate clockwise"
        >
          <RotateCw className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-6" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => useAfpViewerStore.setState((s) => ({ diagnosticsOpen: !s.diagnosticsOpen }))}
          aria-label="AFP Diagnostics"
          className={useAfpViewerStore.getState().diagnosticsOpen ? 'bg-[hsl(var(--accent))]' : ''}
        >
          <Terminal className="h-4 w-4" />
        </Button>
      </div>
    </footer>
  );
}
