'use client';

import { useState, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { splitAfp, batchSplitAfp, downloadBlob, downloadPartsAsZip } from '@/lib/afp/afp-cutter';
import { Scissors, X } from 'lucide-react';

type Mode = 'single' | 'batch';

export function SplitDialog() {
  const splitOpen = useAfpViewerStore((s) => s.splitOpen);
  const fileData = useAfpViewerStore((s) => s.fileData);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const currentPage = useAfpViewerStore((s) => s.currentPage);

  const [mode, setMode] = useState<Mode>('batch');
  const [splitPage, setSplitPage] = useState<number>(currentPage || 1);
  const [chunkSize, setChunkSize] = useState<number>(100);
  const [status, setStatus] = useState<'idle' | 'splitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [timing, setTiming] = useState(0);
  const [resultInfo, setResultInfo] = useState('');

  const totalPages = pageIndex.length;
  const numChunks = Math.ceil(totalPages / Math.max(1, chunkSize));

  const close = useCallback(() => {
    useAfpViewerStore.setState({ splitOpen: false });
    setStatus('idle');
    setError('');
    setResultInfo('');
  }, []);

  const handleSingleSplit = useCallback(() => {
    if (!fileData || !pageIndex.length) return;

    setStatus('splitting');
    setError('');

    requestAnimationFrame(() => {
      try {
        const t0 = performance.now();
        const result = splitAfp(fileData, pageIndex, splitPage);
        const elapsed = performance.now() - t0;
        setTiming(elapsed);

        const stem = (fileName || 'document').replace(/\.afp$/i, '');
        downloadBlob(result.part1, `${stem}_part1.afp`);
        setTimeout(() => {
          downloadBlob(result.part2, `${stem}_part2.afp`);
          setStatus('done');
          setResultInfo(`2 files (${result.part1Pages} + ${result.part2Pages} pages)`);
        }, 300);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Split failed');
        setStatus('error');
      }
    });
  }, [fileData, pageIndex, splitPage, fileName]);

  const handleBatchSplit = useCallback(async () => {
    if (!fileData || !pageIndex.length) return;

    setStatus('splitting');
    setError('');

    // Yield to UI before heavy work
    await new Promise((r) => requestAnimationFrame(r));

    try {
      const t0 = performance.now();
      const parts = batchSplitAfp(fileData, pageIndex, chunkSize);
      const elapsed = performance.now() - t0;

      const stem = (fileName || 'document').replace(/\.afp$/i, '');

      if (parts.length === 1) {
        // Only one chunk — just download the original-sized file directly
        downloadBlob(parts[0].blob, `${stem}.afp`);
        setTiming(elapsed);
        setStatus('done');
        setResultInfo('Document fits in one chunk — downloaded as-is.');
        return;
      }

      // Rename parts with the stem
      for (const p of parts) {
        p.filename = `${stem}_${p.filename}`;
      }

      // Bundle into ZIP
      await downloadPartsAsZip(parts, `${stem}_split.zip`);
      const totalElapsed = performance.now() - t0;
      setTiming(totalElapsed);
      setStatus('done');
      setResultInfo(`${parts.length} files in ZIP (${chunkSize} pages each)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Split failed');
      setStatus('error');
    }
  }, [fileData, pageIndex, chunkSize, fileName]);

  if (!splitOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="w-[420px] rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-[hsl(var(--primary))]" />
            <span className="text-sm font-semibold text-[hsl(var(--foreground))]">
              Split AFP Document
            </span>
          </div>
          <button onClick={close} className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <X className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-[hsl(var(--border))]">
          <button
            onClick={() => setMode('batch')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              mode === 'batch'
                ? 'border-b-2 border-[hsl(var(--primary))] text-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            }`}
          >
            Every N pages
          </button>
          <button
            onClick={() => setMode('single')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              mode === 'single'
                ? 'border-b-2 border-[hsl(var(--primary))] text-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            }`}
          >
            Split at page
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-4 py-4">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Each part is a valid AFP document with all resources (fonts, overlays, medium maps).
          </p>

          {mode === 'batch' ? (
            /* ── Batch mode ── */
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-[hsl(var(--foreground))]">
                  Split every
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))}
                    className="h-8 w-24 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
                  />
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    pages ({totalPages} total)
                  </span>
                </div>
              </div>

              {totalPages > 2 && (
                <input
                  type="range"
                  min={1}
                  max={totalPages}
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                  className="w-full accent-[hsl(var(--primary))]"
                />
              )}

              {/* Batch preview */}
              <div className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 p-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium text-[hsl(var(--foreground))]">
                    {numChunks} file{numChunks !== 1 ? 's' : ''}
                  </span>
                  {numChunks > 1 && (
                    <span className="text-[hsl(var(--muted-foreground))]">
                      downloaded as ZIP
                    </span>
                  )}
                </div>
                {numChunks <= 12 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {Array.from({ length: numChunks }, (_, i) => {
                      const start = i * chunkSize + 1;
                      const end = Math.min((i + 1) * chunkSize, totalPages);
                      return (
                        <div
                          key={i}
                          className="rounded bg-[hsl(var(--primary))]/10 px-1.5 py-0.5 text-[10px] text-[hsl(var(--primary))]"
                        >
                          {start}–{end}
                        </div>
                      );
                    })}
                  </div>
                )}
                {numChunks > 12 && (
                  <p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                    Pages 1–{chunkSize}, {chunkSize + 1}–{chunkSize * 2}, … ,{' '}
                    {(numChunks - 1) * chunkSize + 1}–{totalPages}
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* ── Single split mode ── */
            <div className="space-y-2">
              <label className="text-xs font-medium text-[hsl(var(--foreground))]">
                Split after page
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={totalPages - 1}
                  value={splitPage}
                  onChange={(e) => setSplitPage(Math.max(1, Math.min(totalPages - 1, Number(e.target.value) || 1)))}
                  className="h-8 w-24 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
                />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  of {totalPages} pages
                </span>
              </div>

              {totalPages > 2 && (
                <input
                  type="range"
                  min={1}
                  max={totalPages - 1}
                  value={splitPage}
                  onChange={(e) => setSplitPage(Number(e.target.value))}
                  className="w-full accent-[hsl(var(--primary))]"
                />
              )}

              <div className="flex gap-2 text-[11px]">
                <div className="flex-1 rounded bg-[hsl(var(--primary))]/10 px-2 py-1.5 text-center">
                  <span className="font-medium text-[hsl(var(--primary))]">Part 1</span>
                  <br />
                  Pages 1 – {splitPage}
                </div>
                <div className="flex-1 rounded bg-[hsl(var(--accent))] px-2 py-1.5 text-center">
                  <span className="font-medium text-[hsl(var(--foreground))]">Part 2</span>
                  <br />
                  Pages {splitPage + 1} – {totalPages}
                </div>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs font-medium text-[hsl(var(--destructive))]">{error}</p>
          )}

          {status === 'done' && (
            <p className="text-xs font-medium text-green-600">
              Done in {timing.toFixed(0)} ms — {resultInfo}
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
            onClick={mode === 'batch' ? handleBatchSplit : handleSingleSplit}
            disabled={status === 'splitting' || totalPages < 2}
            className="rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {status === 'splitting'
              ? 'Splitting…'
              : mode === 'batch'
                ? `Split into ${numChunks} file${numChunks !== 1 ? 's' : ''}`
                : 'Split & Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
