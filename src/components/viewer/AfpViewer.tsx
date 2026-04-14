'use client';

import { useEffect, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { FileUpload } from './FileUpload';
import { LoadingOverlay } from './LoadingOverlay';
import { Header } from './Header';
import { Footer } from './Footer';
import { PageCanvas } from './PageCanvas';
import { ThumbnailStrip } from './ThumbnailStrip';
import { SearchPanel } from './SearchPanel';
import { ElementTree } from './ElementTree';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { DocumentInfo } from './DocumentInfo';
import { ExportDialog } from './ExportDialog';
import { AlertCircle } from 'lucide-react';

export function AfpViewer() {
  const {
    status,
    sidebarOpen,
    searchOpen,
    errorMessage,
    handleFileLoad,
    nextPage,
    prevPage,
    zoomIn,
    zoomOut,
    setFitMode,
    toggleSidebar,
    toggleSearch,
    reset,
  } = useAfpViewer();

  const searchOpenStore = useAfpViewerStore((s) => s.searchOpen);
  const elementTreeOpen = useAfpViewerStore((s) => s.elementTreeOpen);
  const diagnosticsOpen = useAfpViewerStore((s) => s.diagnosticsOpen);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't capture shortcuts when typing in an input
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (e.key === 'Escape') {
        if (searchOpenStore) {
          toggleSearch();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        toggleSearch();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoomOut();
        return;
      }

      if (isInput) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case ']':
          e.preventDefault();
          nextPage();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case '[':
          e.preventDefault();
          prevPage();
          break;
        case 'w':
          setFitMode('width');
          break;
        case 'p':
          setFitMode('page');
          break;
        case 't':
          toggleSidebar();
          break;
      }
    },
    [
      nextPage,
      prevPage,
      zoomIn,
      zoomOut,
      setFitMode,
      toggleSidebar,
      toggleSearch,
      searchOpenStore,
    ],
  );

  // Reset stale error state on initial mount
  useEffect(() => {
    if (status === 'error') {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Idle or error state: show file upload
  if (status === 'idle' || status === 'error') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[hsl(var(--background))]">
        {status === 'error' && (
          <>
            <AlertCircle className="h-10 w-10 text-[hsl(var(--destructive))]" />
            <p className="max-w-md text-center text-sm text-[hsl(var(--muted-foreground))]">
              {errorMessage}
            </p>
          </>
        )}
        <FileUpload onFileLoad={handleFileLoad} />
      </div>
    );
  }

  // Loading / indexing state
  if (status === 'loading' || status === 'indexing') {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center bg-[hsl(var(--background))]">
        <FileUpload onFileLoad={handleFileLoad} />
        <LoadingOverlay />
      </div>
    );
  }

  // Ready state: full viewer layout
  return (
    <div className="flex h-screen w-screen flex-col bg-[hsl(var(--background))]">
      <Header onFileLoad={handleFileLoad} />

      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && <ThumbnailStrip />}
        <PageCanvas />
        {elementTreeOpen && <ElementTree />}
      </div>

      <Footer />

      {searchOpen && <SearchPanel />}

      {diagnosticsOpen && (
        <DiagnosticsPanel
          onClose={() => useAfpViewerStore.setState({ diagnosticsOpen: false })}
        />
      )}

      <DocumentInfo />
      <ExportDialog />
    </div>
  );
}
