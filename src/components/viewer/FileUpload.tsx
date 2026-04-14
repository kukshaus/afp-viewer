'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { Upload, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SampleFile {
  name: string;
  size: number;
}

interface FileUploadProps {
  onFileLoad: (file: File) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUpload({ onFileLoad }: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [samples, setSamples] = useState<SampleFile[]>([]);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch sample files on mount
  useEffect(() => {
    fetch('/api/afp/samples')
      .then((res) => res.json())
      .then((data) => {
        if (data.files) setSamples(data.files);
      })
      .catch(() => {});
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        onFileLoad(files[0]);
      }
    },
    [onFileLoad],
  );

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

  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleSampleClick = useCallback(
    async (sample: SampleFile) => {
      setLoadingSample(sample.name);
      try {
        const res = await fetch(`/api/afp/samples/${encodeURIComponent(sample.name)}`);
        if (!res.ok) throw new Error('Failed to fetch sample file');
        const blob = await res.blob();
        const file = new File([blob], sample.name, { type: 'application/octet-stream' });
        onFileLoad(file);
      } catch (err) {
        console.error('Error loading sample:', err);
      } finally {
        setLoadingSample(null);
      }
    },
    [onFileLoad],
  );

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex max-w-lg flex-col items-center gap-4 rounded-lg border-2 border-dashed p-10 transition-colors ${
          isDragOver
            ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/5'
            : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]'
        }`}
      >
        <Upload
          className={`h-10 w-10 ${
            isDragOver
              ? 'text-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))]'
          }`}
        />
        <p className="text-lg font-medium text-[hsl(var(--foreground))]">
          Drag &amp; drop your AFP file here
        </p>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">or</p>
        <Button onClick={handleBrowseClick}>Browse Files</Button>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Supports .afp files up to 2 GB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".afp,.afp2"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Sample files */}
      {samples.length > 0 && (
        <div className="w-full max-w-lg">
          <p className="mb-2 text-sm font-medium text-[hsl(var(--muted-foreground))]">
            Sample files
          </p>
          <div className="flex max-h-[50vh] flex-col gap-1 overflow-auto">
            {samples.map((sample) => (
              <button
                key={sample.name}
                onClick={() => handleSampleClick(sample)}
                disabled={loadingSample !== null}
                className="flex items-center gap-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-50"
              >
                {loadingSample === sample.name ? (
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[hsl(var(--primary))]" />
                ) : (
                  <FileText className="h-5 w-5 shrink-0 text-[hsl(var(--primary))]" />
                )}
                <span className="flex-1 truncate text-sm font-medium text-[hsl(var(--foreground))]">
                  {sample.name}
                </span>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {formatSize(sample.size)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
