'use client';

import { useState, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { X, FileText, FileCode, FileJson, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { exportToHtml } from '@/lib/export/html-exporter';
import { exportToPdf } from '@/lib/export/pdf-exporter';
import { exportToJson } from '@/lib/export/json-exporter';

type ExportFormat = 'html' | 'pdf' | 'json';
type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

const FORMAT_OPTIONS: {
  id: ExportFormat;
  label: string;
  description: string;
  icon: typeof FileText;
}[] = [
  {
    id: 'html',
    label: 'HTML5',
    description: 'Self-contained HTML with all graphics embedded as images. Viewable in any browser.',
    icon: FileCode,
  },
  {
    id: 'pdf',
    label: 'PDF',
    description: 'Multi-page PDF document with all pages rendered at the selected DPI.',
    icon: FileText,
  },
  {
    id: 'json',
    label: 'JSON',
    description: 'All TLE/NOP metadata plus each page as a base64-encoded single-page PDF.',
    icon: FileJson,
  },
];

const DPI_OPTIONS = [96, 150, 300];

export function ExportDialog() {
  const exportOpen = useAfpViewerStore((s) => s.exportOpen);
  const fileData = useAfpViewerStore((s) => s.fileData);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const totalPages = useAfpViewerStore((s) => s.totalPages);

  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [dpi, setDpi] = useState(150);
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const handleClose = useCallback(() => {
    if (status === 'exporting') return; // prevent closing during export
    useAfpViewerStore.setState({ exportOpen: false });
    setStatus('idle');
    setProgress(0);
    setErrorMsg('');
  }, [status]);

  const handleExport = useCallback(async () => {
    if (!fileData || !fileName || pageIndex.length === 0) return;

    setStatus('exporting');
    setProgress(0);
    setProgressTotal(totalPages);
    setErrorMsg('');

    const onProgress = (current: number, total: number) => {
      setProgress(current);
      setProgressTotal(total);
    };

    try {
      switch (format) {
        case 'html':
          await exportToHtml(fileData, pageIndex, { dpi, fileName, onProgress });
          break;
        case 'pdf':
          await exportToPdf(fileData, pageIndex, { dpi, fileName, onProgress });
          break;
        case 'json':
          await exportToJson(fileData, pageIndex, { dpi, fileName, onProgress });
          break;
      }
      setStatus('done');
    } catch (err) {
      console.error('Export failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Export failed');
      setStatus('error');
    }
  }, [fileData, fileName, pageIndex, totalPages, format, dpi]);

  if (!exportOpen) return null;

  const progressPct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={handleClose}
    >
      <div
        className="mx-4 w-full max-w-md rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <h2 className="text-sm font-semibold text-[hsl(var(--foreground))]">
            Export Document
          </h2>
          <button
            onClick={handleClose}
            disabled={status === 'exporting'}
            className="rounded p-1 hover:bg-[hsl(var(--muted))] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Format Selection */}
          <section>
            <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">
              Format
            </h3>
            <div className="space-y-2">
              {FORMAT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const isSelected = format === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setFormat(opt.id)}
                    disabled={status === 'exporting'}
                    className={`w-full rounded-md border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)]'
                        : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.3)]'
                    } disabled:opacity-50`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${isSelected ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} />
                      <span className="text-sm font-medium text-[hsl(var(--foreground))]">
                        {opt.label}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))] leading-relaxed">
                      {opt.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* DPI Selection */}
          <section>
            <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-2">
              Resolution (DPI)
            </h3>
            <div className="flex gap-2">
              {DPI_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDpi(d)}
                  disabled={status === 'exporting'}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    dpi === d
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)] text-[hsl(var(--primary))]'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary)/0.3)]'
                  } disabled:opacity-50`}
                >
                  {d} DPI
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
              Higher DPI = better quality but larger file size. 150 DPI is recommended.
            </p>
          </section>

          {/* Info */}
          <div className="rounded-md bg-[hsl(var(--muted)/0.5)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
            {totalPages} page{totalPages !== 1 ? 's' : ''} will be exported from{' '}
            <span className="font-mono">{fileName}</span>
          </div>

          {/* Progress */}
          {status === 'exporting' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>
                  Rendering page {progress} of {progressTotal}...
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-[hsl(var(--muted))]">
                <div
                  className="h-full rounded-full bg-[hsl(var(--primary))] transition-all duration-200"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Done */}
          {status === 'done' && (
            <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
              Export complete! The file has been downloaded.
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
              {errorMsg || 'Export failed. Please try again.'}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClose}
              disabled={status === 'exporting'}
            >
              {status === 'done' ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={handleExport}
              disabled={status === 'exporting' || !fileData}
            >
              {status === 'exporting' ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Export {format.toUpperCase()}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
