'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { concatAfp, mergeAfpSingleDocument, quickPageCount } from '@/lib/afp/afp-merger';
import type { MergeFileEntry } from '@/lib/afp/afp-merger';
import { downloadBlob } from '@/lib/afp/afp-cutter';
import { Merge, X, Plus, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';

type MergeMode = 'concat' | 'single';

interface FileItem {
  id: string;
  name: string;
  data: ArrayBuffer;
  size: number;
  pageCount: number;
}

let nextId = 0;

export function MergeDialog() {
  const mergeOpen = useAfpViewerStore((s) => s.mergeOpen);
  const currentFileData = useAfpViewerStore((s) => s.fileData);
  const currentFileName = useAfpViewerStore((s) => s.fileName);
  const currentPageIndex = useAfpViewerStore((s) => s.pageIndex);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [mode, setMode] = useState<MergeMode>('concat');
  const [status, setStatus] = useState<'idle' | 'merging' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [timing, setTiming] = useState(0);
  const [resultInfo, setResultInfo] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed with currently open file when dialog opens
  useEffect(() => {
    if (mergeOpen && currentFileData && currentFileName) {
      setFiles([{
        id: `f-${nextId++}`,
        name: currentFileName,
        data: currentFileData,
        size: currentFileData.byteLength,
        pageCount: currentPageIndex.length || quickPageCount(currentFileData),
      }]);
    }
    if (!mergeOpen) {
      setFiles([]);
      setStatus('idle');
      setError('');
      setResultInfo('');
    }
  }, [mergeOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    useAfpViewerStore.setState({ mergeOpen: false });
  }, []);

  const addFiles = useCallback(async (fileList: FileList) => {
    const newItems: FileItem[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const data = await file.arrayBuffer();
      newItems.push({
        id: `f-${nextId++}`,
        name: file.name,
        data,
        size: data.byteLength,
        pageCount: quickPageCount(data),
      });
    }
    setFiles((prev) => [...prev, ...newItems]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const moveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setFiles((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((index: number) => {
    setFiles((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  const handleMerge = useCallback(async () => {
    if (files.length < 2) return;
    setStatus('merging');
    setError('');

    await new Promise((r) => requestAnimationFrame(r));

    try {
      const t0 = performance.now();
      const entries: MergeFileEntry[] = files.map((f) => ({
        name: f.name,
        data: f.data,
        pageCount: f.pageCount,
      }));

      const result = mode === 'single'
        ? mergeAfpSingleDocument(entries)
        : concatAfp(entries);

      const elapsed = performance.now() - t0;
      setTiming(elapsed);

      const stem = files[0].name.replace(/\.afp$/i, '');
      downloadBlob(result.blob, `${stem}_merged.afp`);

      setStatus('done');
      setResultInfo(
        `${result.totalPages} pages, ${(result.totalBytes / 1_048_576).toFixed(1)} MB` +
        (mode === 'single' ? ' (single document)' : ' (multi-document)')
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed');
      setStatus('error');
    }
  }, [files, mode]);

  if (!mergeOpen) return null;

  const totalPages = files.reduce((s, f) => s + f.pageCount, 0);
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="w-[480px] max-h-[80vh] flex flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <Merge className="h-4 w-4 text-[hsl(var(--primary))]" />
            <span className="text-sm font-semibold text-[hsl(var(--foreground))]">
              Merge AFP Documents
            </span>
          </div>
          <button onClick={close} className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <X className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-[hsl(var(--border))]">
          <button
            onClick={() => setMode('concat')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              mode === 'concat'
                ? 'border-b-2 border-[hsl(var(--primary))] text-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            }`}
          >
            Concatenate
          </button>
          <button
            onClick={() => setMode('single')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              mode === 'single'
                ? 'border-b-2 border-[hsl(var(--primary))] text-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            }`}
          >
            Single document
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
            {mode === 'concat'
              ? 'Files are appended as-is. Each keeps its own resources and document envelope (BDT/EDT). Always valid.'
              : 'Pages from all files are merged into one document using file 1\'s envelope and resources. Resources from other files are injected.'}
          </p>

          {/* File list */}
          <div className="space-y-1">
            {files.map((file, i) => (
              <div
                key={file.id}
                className="flex items-center gap-2 rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 px-2 py-1.5"
              >
                <span className="w-5 shrink-0 text-center text-[10px] font-medium text-[hsl(var(--muted-foreground))]">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-xs font-medium text-[hsl(var(--foreground))]">
                    {file.name}
                  </p>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                    {file.pageCount} pages, {(file.size / 1024).toFixed(0)} KB
                  </p>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    className="rounded p-0.5 hover:bg-[hsl(var(--accent))] disabled:opacity-30"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => moveDown(i)}
                    disabled={i === files.length - 1}
                    className="rounded p-0.5 hover:bg-[hsl(var(--accent))] disabled:opacity-30"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => removeFile(file.id)}
                    className="rounded p-0.5 text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add files button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-[hsl(var(--border))] py-2 text-xs text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add AFP files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".afp,.AFP,.afp2"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                addFiles(e.target.files);
              }
              // Reset so the same file(s) can be picked again
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />

          {/* Stats */}
          {files.length >= 2 && (
            <div className="rounded bg-[hsl(var(--muted))]/50 px-3 py-2 text-[11px]">
              <span className="font-medium text-[hsl(var(--foreground))]">
                {files.length} files
              </span>
              <span className="text-[hsl(var(--muted-foreground))]">
                {' '}{totalPages} pages, {(totalSize / 1_048_576).toFixed(1)} MB total
              </span>
            </div>
          )}

          {error && (
            <p className="text-xs font-medium text-[hsl(var(--destructive))]">{error}</p>
          )}

          {status === 'done' && (
            <p className="text-xs font-medium text-green-600">
              Merged in {timing.toFixed(0)} ms — {resultInfo}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--border))] px-4 py-3">
          <button
            onClick={close}
            className="rounded px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={status === 'merging' || files.length < 2}
            className="rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {status === 'merging' ? 'Merging…' : `Merge ${files.length} files`}
          </button>
        </div>
      </div>
    </div>
  );
}
