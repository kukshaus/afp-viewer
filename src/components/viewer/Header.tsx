'use client';

import { useRef, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { Menu, Search, Upload, X, MousePointer2, List, FileWarning, Info, Download, Scissors, Merge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

interface HeaderProps {
  onFileLoad: (file: File) => void;
}

export function Header({ onFileLoad }: HeaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toggleSidebar, toggleSearch, goToPage, reset } = useAfpViewer();
  const fileName = useAfpViewerStore((s) => s.fileName);
  const currentPage = useAfpViewerStore((s) => s.currentPage);
  const totalPages = useAfpViewerStore((s) => s.totalPages);
  const elementSelectMode = useAfpViewerStore((s) => s.elementSelectMode);
  const toggleElementSelectMode = useAfpViewerStore((s) => s.toggleElementSelectMode);
  const toggleElementTree = useAfpViewerStore((s) => s.toggleElementTree);

  const handlePageChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value)) {
        goToPage(value);
      }
    },
    [goToPage],
  );

  const handlePageKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const value = parseInt((e.target as HTMLInputElement).value, 10);
        if (!isNaN(value)) {
          goToPage(value);
        }
      }
    },
    [goToPage],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onFileLoad(files[0]);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [onFileLoad],
  );

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
      {/* Left: sidebar toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
      >
        <Menu className="h-4 w-4" />
      </Button>

      {/* Center-left: title and file name */}
      <span className="ml-2 text-sm font-semibold text-[hsl(var(--foreground))]">
        AFP Viewer
      </span>
      {fileName && (
        <>
          <span className="ml-2 max-w-[200px] truncate text-sm text-[hsl(var(--muted-foreground))]">
            - {fileName}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            aria-label="Close file"
            className="ml-1 h-6 w-6 p-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleElementSelectMode}
          aria-label="Toggle element selection"
          className={elementSelectMode ? 'bg-[hsl(var(--accent))]' : ''}
        >
          <MousePointer2 className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={toggleElementTree}
          aria-label="Toggle element tree"
        >
          <List className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSearch}
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => useAfpViewerStore.setState((s) => ({ docInfoOpen: !s.docInfoOpen }))}
          aria-label="Document info"
        >
          <Info className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => useAfpViewerStore.setState((s) => ({ exportOpen: !s.exportOpen }))}
          aria-label="Export document"
          disabled={!fileName}
        >
          <Download className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => useAfpViewerStore.setState((s) => ({ splitOpen: !s.splitOpen }))}
          aria-label="Split document"
          disabled={!fileName}
        >
          <Scissors className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => useAfpViewerStore.setState((s) => ({ mergeOpen: !s.mergeOpen }))}
          aria-label="Merge documents"
        >
          <Merge className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleUploadClick}
          aria-label="Upload file"
        >
          <Upload className="h-4 w-4" />
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".afp,.afp2"
          onChange={handleFileChange}
          className="hidden"
        />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Page navigation */}
        <span className="text-xs text-[hsl(var(--muted-foreground))]">
          Page
        </span>
        <Input
          type="number"
          min={1}
          max={totalPages}
          value={currentPage}
          onChange={handlePageChange}
          onKeyDown={handlePageKeyDown}
          className="mx-1 h-7 w-16 text-center text-xs"
        />
        <span className="text-xs text-[hsl(var(--muted-foreground))]">
          of {totalPages}
        </span>
      </div>
    </header>
  );
}
