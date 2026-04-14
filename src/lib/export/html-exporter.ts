/**
 * HTML5 Exporter
 *
 * Exports the entire AFP document as a self-contained HTML5 file with all
 * graphics embedded as base64 PNG data URLs. The HTML includes navigation,
 * print-friendly CSS, and responsive layout.
 */

import type { PageIndex } from '@/lib/afp/types';
import { renderPageToDataUrl } from './render-helper';

export interface HtmlExportOptions {
  dpi: number;
  fileName: string;
  onProgress?: (current: number, total: number) => void;
}

/**
 * Exports the AFP document as a self-contained HTML5 string.
 * Triggers a download in the browser.
 */
export async function exportToHtml(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  options: HtmlExportOptions,
): Promise<void> {
  const { dpi, fileName, onProgress } = options;
  const total = pageIndex.length;

  // Render all pages to PNG data URLs
  const pageImages: { dataUrl: string; width: number; height: number; pageNum: number }[] = [];

  for (let i = 0; i < total; i++) {
    const entry = pageIndex[i];
    onProgress?.(i + 1, total);

    const result = await renderPageToDataUrl(fileData, entry, dpi);
    if (result) {
      pageImages.push({
        ...result,
        pageNum: entry.pageNumber,
      });
    }

    // Yield to UI thread every 5 pages
    if (i % 5 === 4) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const docTitle = fileName.replace(/\.afp\d?$/i, '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(docTitle)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f0f0;
    color: #333;
  }
  header {
    position: sticky; top: 0; z-index: 100;
    background: #1a1a2e; color: #fff;
    padding: 8px 16px;
    display: flex; align-items: center; justify-content: space-between;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  header h1 { font-size: 14px; font-weight: 600; }
  header .info { font-size: 12px; opacity: .7; }
  nav {
    position: sticky; top: 40px; z-index: 90;
    background: #fff; border-bottom: 1px solid #ddd;
    padding: 6px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    font-size: 12px;
  }
  nav a {
    color: #1a73e8; text-decoration: none; padding: 2px 6px;
    border-radius: 3px;
  }
  nav a:hover { background: #e8f0fe; }
  .pages { padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .page-container {
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.15);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  }
  .page-container img {
    display: block;
    max-width: 100%;
    height: auto;
  }
  .page-label {
    position: absolute; top: 4px; right: 8px;
    background: rgba(0,0,0,.5); color: #fff;
    font-size: 11px; padding: 2px 8px; border-radius: 3px;
  }
  @media print {
    header, nav { display: none !important; }
    body { background: #fff; }
    .pages { padding: 0; gap: 0; }
    .page-container {
      box-shadow: none; border-radius: 0;
      page-break-after: always;
    }
    .page-label { display: none; }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(docTitle)}</h1>
  <span class="info">${total} page${total !== 1 ? 's' : ''} &bull; Exported from AFP Viewer</span>
</header>
<nav>
  ${pageImages.map((p) => `<a href="#page-${p.pageNum}">${p.pageNum}</a>`).join('\n  ')}
</nav>
<div class="pages">
${pageImages
  .map(
    (p) => `  <div class="page-container" id="page-${p.pageNum}">
    <img src="${p.dataUrl}" width="${p.width}" height="${p.height}" alt="Page ${p.pageNum}">
    <span class="page-label">Page ${p.pageNum}</span>
  </div>`,
  )
  .join('\n')}
</div>
</body>
</html>`;

  triggerDownload(html, `${docTitle}.html`, 'text/html');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function triggerDownload(content: string, filename: string, mimeType: string): void {
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
