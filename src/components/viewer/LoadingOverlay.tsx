'use client';

import { useAfpViewerStore } from '@/store/afpViewerStore';
import { FileText } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
}

export function LoadingOverlay() {
  const status = useAfpViewerStore((s) => s.status);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const fileSize = useAfpViewerStore((s) => s.fileSize);
  const indexProgress = useAfpViewerStore((s) => s.indexProgress);
  const pagesFound = useAfpViewerStore((s) => s.pagesFound);

  const isIndexing = status === 'indexing';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-80 flex-col items-center gap-4 rounded-lg bg-[hsl(var(--card))] p-6 shadow-xl">
        <FileText className="h-10 w-10 text-[hsl(var(--primary))]" />

        {fileName && (
          <p className="max-w-full truncate text-sm font-medium text-[hsl(var(--foreground))]">
            {fileName}
          </p>
        )}

        {fileSize > 0 && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {formatFileSize(fileSize)}
          </p>
        )}

        <Progress value={isIndexing ? indexProgress : undefined} className="w-full" />

        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {isIndexing
            ? `Indexing... Found ${pagesFound} page${pagesFound !== 1 ? 's' : ''}`
            : 'Loading...'}
        </p>

        {isIndexing && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {indexProgress}%
          </p>
        )}
      </div>
    </div>
  );
}
