/**
 * AFP Page Manager — reassemble a valid AFP document from a
 * subset/reorder of pages.
 *
 * Uses the same preamble/postamble pattern as the splitter:
 *   preamble (BDT + resources) + pages in new order + postamble (EDT)
 */

import type { PageIndex } from '@/lib/afp/types';

/**
 * Build a new AFP document containing only the pages listed in `pageOrder`
 * (0-based indices into the original pageIndex), in that exact order.
 *
 * @param fileData     Original AFP ArrayBuffer
 * @param pageIndex    Page index from the scanner
 * @param pageOrder    Array of 0-based page indices in desired order
 * @returns            A Blob with the reassembled AFP
 */
export function reassembleAfp(
  fileData: ArrayBuffer,
  pageIndex: PageIndex[],
  pageOrder: number[],
): Blob {
  const total = pageIndex.length;
  if (total === 0) throw new Error('No pages in document');
  if (pageOrder.length === 0) throw new Error('No pages selected');

  // Preamble: everything before the first page
  const preambleEnd = pageIndex[0].byteOffset;
  const preamble = fileData.slice(0, preambleEnd);

  // Postamble: everything after the last page to end of file
  const lastPage = pageIndex[total - 1];
  const postambleStart = lastPage.byteOffset + lastPage.byteLength;
  const postamble = fileData.slice(postambleStart);

  // Pages in the requested order
  const pageSlices: ArrayBuffer[] = [];
  for (const idx of pageOrder) {
    if (idx < 0 || idx >= total) continue;
    const pg = pageIndex[idx];
    pageSlices.push(fileData.slice(pg.byteOffset, pg.byteOffset + pg.byteLength));
  }

  return new Blob([preamble, ...pageSlices, postamble], {
    type: 'application/octet-stream',
  });
}
