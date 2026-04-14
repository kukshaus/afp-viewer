/**
 * JSON Exporter
 *
 * Exports the AFP document as a rich JSON object containing:
 * - All TLE (Tagged Logical Element) metadata from the entire document
 * - All NOP (No Operation / comment) metadata
 * - Document-level information (name, page count, file size)
 * - Each page as a base64-encoded single-page PDF
 */

import type { PageIndex } from '@/lib/afp/types';
import { extractAllMetadata } from './metadata-extractor';
import { renderPageToPngBytes } from './render-helper';
import { renderPageAsPdfBytes } from './pdf-exporter';

export interface JsonExportOptions {
  dpi: number;
  fileName: string;
  onProgress?: (current: number, total: number) => void;
}

interface JsonExportPage {
  pageNumber: number;
  /** Base64-encoded single-page PDF */
  pdfBase64: string;
  /** Pixel width of the rendered page */
  renderedWidth: number;
  /** Pixel height of the rendered page */
  renderedHeight: number;
}

interface JsonExportDocument {
  exportInfo: {
    format: 'afp-viewer-export-v1';
    exportedAt: string;
    sourceFile: string;
    dpi: number;
  };
  document: {
    name: string;
    totalPages: number;
    fileSize: number;
    fileSizeHuman: string;
  };
  metadata: {
    tles: Array<{
      key: string;
      value: string;
      context: string;
    }>;
    nops: Array<{
      value: string;
      context: string;
    }>;
  };
  pages: JsonExportPage[];
}

/**
 * Exports the AFP document as JSON and triggers a browser download.
 */
export async function exportToJson(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  options: JsonExportOptions,
): Promise<void> {
  const { dpi, fileName, onProgress } = options;
  const total = pageIndex.length;

  // Extract all metadata from the file
  const meta = extractAllMetadata(fileData, total);

  // Render each page as a single-page PDF, base64-encoded
  const pages: JsonExportPage[] = [];

  for (let i = 0; i < total; i++) {
    const entry = pageIndex[i];
    onProgress?.(i + 1, total);

    const pngResult = await renderPageToPngBytes(fileData, entry, dpi);
    if (!pngResult) {
      pages.push({
        pageNumber: entry.pageNumber,
        pdfBase64: '',
        renderedWidth: 0,
        renderedHeight: 0,
      });
      continue;
    }

    const pdfBytes = await renderPageAsPdfBytes(
      pngResult.pngBytes,
      pngResult.width,
      pngResult.height,
      dpi,
    );

    // Convert to base64
    let binary = '';
    for (let j = 0; j < pdfBytes.length; j++) {
      binary += String.fromCharCode(pdfBytes[j]);
    }
    const pdfBase64 = btoa(binary);

    pages.push({
      pageNumber: entry.pageNumber,
      pdfBase64,
      renderedWidth: pngResult.width,
      renderedHeight: pngResult.height,
    });

    // Yield to UI thread every 2 pages
    if (i % 2 === 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const output: JsonExportDocument = {
    exportInfo: {
      format: 'afp-viewer-export-v1',
      exportedAt: new Date().toISOString(),
      sourceFile: fileName,
      dpi,
    },
    document: {
      name: meta.documentName || fileName.replace(/\.afp\d?$/i, ''),
      totalPages: meta.totalPages,
      fileSize: meta.fileSize,
      fileSizeHuman: formatSize(meta.fileSize),
    },
    metadata: {
      tles: meta.tles.map((t) => ({
        key: t.key,
        value: t.value,
        context: t.context,
      })),
      nops: meta.nops.map((n) => ({
        value: n.value,
        context: n.context,
      })),
    },
    pages,
  };

  const jsonStr = JSON.stringify(output, null, 2);
  const docTitle = fileName.replace(/\.afp\d?$/i, '');
  triggerDownload(jsonStr, `${docTitle}.json`, 'application/json');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function triggerDownload(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
