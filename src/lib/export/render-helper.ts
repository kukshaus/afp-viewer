/**
 * Render Helper for Export
 *
 * Shared utilities for rendering AFP pages to PNG data URLs and buffers.
 * Used by all three export formats (HTML, PDF, JSON).
 */

import { parsePage } from '@/lib/afp/page-parser';
import { renderPage } from '@/lib/renderer/compositor';
import type { PageIndex } from '@/lib/afp/types';

/**
 * Renders a single AFP page to a PNG data URL.
 *
 * @param fileData  - The full AFP file ArrayBuffer
 * @param entry     - Page index entry with byte offset/length
 * @param dpi       - Rendering resolution (default 150)
 * @returns PNG data URL string, or null on failure
 */
export async function renderPageToDataUrl(
  fileData: ArrayBuffer,
  entry: PageIndex,
  dpi: number = 150,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const tree = parsePage(fileData, entry.byteOffset, entry.byteLength);
    const canvas = await renderPage(tree, dpi, 1.0, false);

    // Convert canvas to data URL
    if ('toDataURL' in canvas) {
      return {
        dataUrl: (canvas as HTMLCanvasElement).toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
      };
    }

    // OffscreenCanvas path
    if ('convertToBlob' in canvas) {
      const blob = await (canvas as OffscreenCanvas).convertToBlob({
        type: 'image/png',
      });
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return {
        dataUrl: 'data:image/png;base64,' + btoa(binary),
        width: canvas.width,
        height: canvas.height,
      };
    }

    return null;
  } catch (err) {
    console.warn(`Failed to render page ${entry.pageNumber}:`, err);
    return null;
  }
}

/**
 * Renders a single AFP page and returns the raw PNG bytes (Uint8Array).
 */
export async function renderPageToPngBytes(
  fileData: ArrayBuffer,
  entry: PageIndex,
  dpi: number = 150,
): Promise<{ pngBytes: Uint8Array; width: number; height: number } | null> {
  try {
    const tree = parsePage(fileData, entry.byteOffset, entry.byteLength);
    const canvas = await renderPage(tree, dpi, 1.0, false);

    // OffscreenCanvas path
    if ('convertToBlob' in canvas) {
      const blob = await (canvas as OffscreenCanvas).convertToBlob({
        type: 'image/png',
      });
      const arrayBuffer = await blob.arrayBuffer();
      return {
        pngBytes: new Uint8Array(arrayBuffer),
        width: canvas.width,
        height: canvas.height,
      };
    }

    // HTMLCanvasElement path
    if ('toDataURL' in canvas) {
      const dataUrl = (canvas as HTMLCanvasElement).toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return {
        pngBytes: bytes,
        width: canvas.width,
        height: canvas.height,
      };
    }

    return null;
  } catch (err) {
    console.warn(`Failed to render page ${entry.pageNumber}:`, err);
    return null;
  }
}
