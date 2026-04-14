/**
 * PDF Exporter
 *
 * Exports the entire AFP document as a multi-page PDF with all graphics
 * rendered at the specified DPI. Uses pdf-lib (pure JS, browser-compatible).
 */

import { PDFDocument } from 'pdf-lib';
import type { PageIndex } from '@/lib/afp/types';
import { renderPageToPngBytes } from './render-helper';

export interface PdfExportOptions {
  dpi: number;
  fileName: string;
  onProgress?: (current: number, total: number) => void;
}

/**
 * Exports the AFP document as a PDF and triggers a browser download.
 */
export async function exportToPdf(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  options: PdfExportOptions,
): Promise<void> {
  const { dpi, fileName, onProgress } = options;
  const total = pageIndex.length;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(fileName.replace(/\.afp\d?$/i, ''));
  pdfDoc.setProducer('AFP Viewer');
  pdfDoc.setCreator('AFP Viewer — HTML5 Export');

  for (let i = 0; i < total; i++) {
    const entry = pageIndex[i];
    onProgress?.(i + 1, total);

    const result = await renderPageToPngBytes(fileData, entry, dpi);
    if (!result) continue;

    const pngImage = await pdfDoc.embedPng(result.pngBytes);

    // Calculate PDF page size in points (72 points per inch)
    const widthPt = (result.width / dpi) * 72;
    const heightPt = (result.height / dpi) * 72;

    const page = pdfDoc.addPage([widthPt, heightPt]);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: widthPt,
      height: heightPt,
    });

    // Yield to UI thread every 3 pages
    if (i % 3 === 2) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const pdfBytes = await pdfDoc.save();
  const docTitle = fileName.replace(/\.afp\d?$/i, '');
  triggerDownload(pdfBytes, `${docTitle}.pdf`, 'application/pdf');
}

/**
 * Creates a single-page PDF from a PNG image and returns it as a Uint8Array.
 * Used by the JSON exporter to embed each page as base64 PDF.
 */
export async function renderPageAsPdfBytes(
  pngBytes: Uint8Array,
  width: number,
  height: number,
  dpi: number,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const pngImage = await pdfDoc.embedPng(pngBytes);

  const widthPt = (width / dpi) * 72;
  const heightPt = (height / dpi) * 72;

  const page = pdfDoc.addPage([widthPt, heightPt]);
  page.drawImage(pngImage, {
    x: 0,
    y: 0,
    width: widthPt,
    height: heightPt,
  });

  return await pdfDoc.save();
}

function triggerDownload(
  data: Uint8Array,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
