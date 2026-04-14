/**
 * AFP Page Parser — Pass 2 (on-demand)
 *
 * Given a byte range corresponding to a single page (BPG through EPG inclusive),
 * parses all structured fields within that range and builds a PageRenderTree
 * ready for the compositor.
 *
 * The parser tracks state through sub-architecture begin/end markers (BPT/EPT,
 * BIM/EIM, BGR/EGR, BBC/EBC) and accumulates data fields (PTX, IDD, IDE, GAD,
 * BDD) to construct typed PageObject entries.
 */

import { iterateStructuredFields } from '@/lib/afp/parser';
import { parsePTOCA } from '@/lib/ptoca/parser';
import { parseEmbeddedCodePages } from '@/lib/afp/codepage-parser';
import { registerCodePage, setDefaultCodePage } from '@/lib/ebcdic/transcoder';
import { parseIMImages, parseIMImageAt, renderIMImageToDataUrl } from '@/lib/afp/im-image-parser';

// Global cache for IM Images — cleared on each new file load
let _cachedIMImages: Map<string, { dataUrl: string; width: number; height: number; resolution: number }> | null = null;
let _cachedBufferSize = 0;

import type {
  PageRenderTree,
  PageObject,
  AFPStructuredField,
  IOCAImageObject,
  GOCAObject,
  GOCADrawingOrder,
  BCOCAObject,
  FontMapping,
  FontMappingTable,
} from '@/lib/afp/types';
import {
  IOCACompression,
  IOCAColorModel,
  GOCADrawingOrderType,
  BarcodeType,
} from '@/lib/afp/types';
import { ebcdicToUnicode } from '@/lib/ebcdic/transcoder';

// ---------------------------------------------------------------------------
// Structured field type IDs used during page parsing
// ---------------------------------------------------------------------------

const TYPE_BPG = 'D3A8AD'; // Begin Page
const _TYPE_EPG = 'D3A9AD'; // End Page (used for reference)
const TYPE_PGD = 'D3A6AF'; // Page Descriptor

// Presentation text — standard (7B) and alternate (9B) type codes
const TYPE_BPT = 'D3A87B'; // Begin Presentation Text (standard)
const TYPE_EPT = 'D3A97B'; // End Presentation Text (standard)
const TYPE_BPT_ALT = 'D3A89B'; // Begin Presentation Text (alternate)
const TYPE_EPT_ALT = 'D3A99B'; // End Presentation Text (alternate)
const TYPE_PTD = 'D3EEEE'; // Presentation Text Descriptor
const TYPE_PTX = 'D3EE9B'; // Presentation Text Data (alternate/common)
const TYPE_PTX_STD = 'D3EE6B'; // Presentation Text Data (standard)

// Image — standard IOCA
const TYPE_BIM = 'D3A8C5'; // Begin Image (IOCA)
const TYPE_EIM = 'D3A9C5'; // End Image (IOCA)
const TYPE_IDD = 'D3ACCE'; // Image Data Descriptor
const TYPE_IDE = 'D3EE7B'; // Image Data Element

// Image — IM Image (alternate, older format)
const TYPE_BII = 'D3A892'; // Begin IM Image
const TYPE_EII = 'D3A992'; // End IM Image
const TYPE_IID = 'D3EE92'; // IM Image Data

// Object Container (wraps images in some files)
const TYPE_BOC = 'D3A8CE'; // Begin Object Container
const TYPE_EOC = 'D3A9CE'; // End Object Container

// Include Object (references an external/inline resource)
const TYPE_IOC = 'D3AFC3'; // Include Object

// Graphics
const TYPE_BGR = 'D3A8C3'; // Begin Graphics
const TYPE_EGR = 'D3A9C3'; // End Graphics
const TYPE_GAD = 'D3EECC'; // Graphics Data

// Bar code
const TYPE_BBC = 'D3A8EB'; // Begin Bar Code
const TYPE_EBC = 'D3A9EB'; // End Bar Code
const TYPE_BDD = 'D3AEEB'; // Bar Code Data Descriptor

// Object area positioning
const TYPE_OBP = 'D3AC6B'; // Object Area Position

// Include Page Overlay — sets coordinate origin for following content
const TYPE_IPO = 'D3AFD8'; // Include Page Overlay

// Page Segment (container for images/graphics referenced by IPS)
const TYPE_BPS = 'D3A85F'; // Begin Page Segment
const TYPE_EPS = 'D3A95F'; // End Page Segment
const TYPE_OCD = 'D3EEBB'; // Object Container Data (GOCA inside page segments)

// Document and resource boundaries (used for page fallback)
const TYPE_BDT = 'D3A8A8'; // Begin Document
const TYPE_BRS = 'D3A8AF'; // Begin Resource
const TYPE_ERS = 'D3A9AF'; // End Resource
const TYPE_BAG = 'D3A8C9'; // Begin Active Environment Group
const TYPE_MCF = 'D3AB8A'; // Map Coded Font (MCF / MCF-1)

// Default page dimensions (8.5" x 11" at 1440 L-units/inch)
const DEFAULT_PAGE_WIDTH = 12240;  // 8.5 * 1440
const DEFAULT_PAGE_HEIGHT = 15840; // 11 * 1440
const DEFAULT_RESOLUTION = 1440;

// ---------------------------------------------------------------------------
// Sub-architecture parse state
// ---------------------------------------------------------------------------

type SubArchKind = 'text' | 'image' | 'graphics' | 'barcode' | null;

interface ParseState {
  /** Currently active sub-architecture, or null if between objects. */
  currentArch: SubArchKind;

  /** Current object area position (set by OBP before a sub-arch begins). */
  objectX: number;
  objectY: number;
  objectWidth: number;
  objectHeight: number;

  /** Current overlay offset (set by IPO Include Page Overlay). */
  overlayOffsetX: number;
  overlayOffsetY: number;

  /** Count of BRS blocks encountered — only render content from the first. */
  brsCount: number;

  /** The full file buffer — needed for scanning page segment resources. */
  fullBuffer: ArrayBuffer | null;
  /** Absolute byte offset of this page in the file — for nearest-copy lookup. */
  pageByteOffset: number;
  /** Actual page resolution (L-units per inch), set from PGD. */
  pageResolution: number;

  /** Active MCF font local-ID → mapping table for this page (if any). */
  fontMap: FontMappingTable | undefined;

  // Text accumulation
  ptxChunks: Uint8Array[];

  // Image accumulation
  imageDescriptor: Partial<IOCAImageObject>;
  ideChunks: Uint8Array[];

  // Graphics accumulation
  gadChunks: Uint8Array[];

  // Barcode accumulation
  barcodeDescriptor: Partial<BCOCAObject>;
  barcodeDataChunks: Uint8Array[];
}

function freshState(): ParseState {
  return {
    currentArch: null,
    objectX: 0,
    objectY: 0,
    objectWidth: 0,
    objectHeight: 0,
    overlayOffsetX: 0,
    overlayOffsetY: 0,
    brsCount: 0,
    fullBuffer: null,
    pageByteOffset: 0,
    pageResolution: DEFAULT_RESOLUTION,
    fontMap: undefined,
    ptxChunks: [],
    imageDescriptor: {},
    ideChunks: [],
    gadChunks: [],
    barcodeDescriptor: {},
    barcodeDataChunks: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a big-endian unsigned 16-bit value from a Uint8Array. */
function readU16(data: Uint8Array, offset: number): number {
  if (offset + 1 >= data.length) return 0;
  return (data[offset] << 8) | data[offset + 1];
}

/** Read a big-endian unsigned 24-bit value (3 bytes). */
function readU24(data: Uint8Array, offset: number): number {
  if (offset + 2 >= data.length) return 0;
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

/** Read a big-endian signed 16-bit value. */
function _readS16(data: Uint8Array, offset: number): number {
  const u = readU16(data, offset);
  return u >= 0x8000 ? u - 0x10000 : u;
}

/** Concatenate an array of Uint8Array chunks into one. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Inline resource scanner
// ---------------------------------------------------------------------------

interface InlineResource {
  name: string;
  data: Uint8Array;
  isJpeg: boolean;
}

/**
 * Pre-scans the full file buffer for inline image resources (IM Image objects
 * defined in BII/IID/EII blocks before the page data). Returns a map from
 * resource name to image data.
 */
function scanInlineResources(buffer: ArrayBuffer): Map<string, InlineResource> {
  const resources = new Map<string, InlineResource>();
  let currentName = '';
  let currentChunks: Uint8Array[] = [];
  let isJpeg = false;
  let inImage = false;

  for (const field of iterateStructuredFields(buffer)) {
    if (field.typeId === TYPE_BII) {
      // Begin IM Image — extract resource name from first 8 bytes
      inImage = true;
      currentChunks = [];
      isJpeg = false;
      if (field.data.length >= 8) {
        currentName = extractEbcdicName(field.data, 0, 8);
      }
    } else if (field.typeId === TYPE_IID && inImage) {
      // IM Image Data — collect the image bytes
      if (field.data.length > 0) {
        if (field.data.length >= 2 && field.data[0] === 0xFF && field.data[1] === 0xD8) {
          isJpeg = true;
        }
        currentChunks.push(field.data.slice());
      }
    } else if (field.typeId === TYPE_EII && inImage) {
      // End IM Image — finalize resource
      inImage = false;
      if (currentName && currentChunks.length > 0) {
        const totalLen = currentChunks.reduce((s, c) => s + c.length, 0);
        const combined = new Uint8Array(totalLen);
        let off = 0;
        for (const chunk of currentChunks) {
          combined.set(chunk, off);
          off += chunk.length;
        }
        resources.set(currentName, { name: currentName, data: combined, isJpeg });
      }
    }
    // Stop scanning once we hit page content (optimization)
    if (field.typeId === TYPE_BDT) break;
  }

  return resources;
}

/**
 * Pre-scans the file for Page Segment resources (BPS/EPS) containing GOCA
 * graphics (OCD data). These are referenced by IPS (Include Page Segment)
 * records during page rendering. Returns a map from segment name to OCD data.
 */
/** Extract an EBCDIC name from data bytes, trimming padding. */
function extractEbcdicName(data: Uint8Array, offset: number, length: number): string {
  let name = '';
  for (let i = offset; i < offset + length && i < data.length; i++) {
    const b = data[i];
    if (b === 0x40) break; // EBCDIC space = padding
    if (b >= 0xC1 && b <= 0xC9) name += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) name += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) name += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0xF0 && b <= 0xF9) name += String.fromCharCode(48 + b - 0xF0);
    else name += String.fromCharCode(b);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Map Coded Font (MCF) parser & bold detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an IBM AFP character set name represents a bold weight.
 *
 * IBM character set names follow the pattern `C0xx....` where the 4th
 * character (1-based position 4) selects a weight within the same family:
 * - `L` (Light)  → regular  (e.g. C0FL20A0)
 * - `M` (Medium) → bold     (e.g. C0FM20E0)
 * - `H` (Heavy)  → bold
 * - `B` (Bold)   → bold
 *
 * Other patterns default to regular. The viewer falls back to regular when
 * no character set name is available.
 */
function isBoldCharSet(name: string | null): boolean {
  if (!name || name.length < 4) return false;
  const weightChar = name.charAt(3).toUpperCase();
  return weightChar === 'M' || weightChar === 'B' || weightChar === 'H';
}

/**
 * Parse a single MCF (D3AB8A) structured field's data into FontMapping rows.
 *
 * MCF-1 layout:
 *   For each repeating group:
 *     [RGLength: 2 bytes BE]
 *     [Triplets ...]
 *
 *   Each triplet:
 *     [TLength: 1] [TType: 1] [TData: TLength-2]
 *
 * Triplets we care about:
 *   - 0x24 (Resource Local Identifier): bytes [resType, localId]
 *   - 0x02 (Fully Qualified Name): [FQNType, FQNFormat, name (8 bytes EBCDIC)]
 *     - FQNType 0x85 → Coded Font Name (e.g. "T10D1144")
 *     - FQNType 0x86 → Character Set / Code Page Name (e.g. "C0FL20A0")
 */
function parseMCF(data: Uint8Array): FontMapping[] {
  const mappings: FontMapping[] = [];
  let i = 0;

  while (i + 2 <= data.length) {
    const rgLen = (data[i] << 8) | data[i + 1];
    if (rgLen < 4 || i + rgLen > data.length) break;

    const rg = data.subarray(i + 2, i + rgLen);

    let codedFontName: string | null = null;
    let characterSetName: string | null = null;
    let localId: number | null = null;

    let j = 0;
    while (j < rg.length) {
      const tLen = rg[j];
      if (tLen < 2 || j + tLen > rg.length) break;
      const tType = rg[j + 1];

      if (tType === 0x24 && tLen >= 4) {
        // Resource Local Identifier — byte 3 is the local ID
        localId = rg[j + 3];
      } else if (tType === 0x02 && tLen >= 4) {
        // Fully Qualified Name
        const fqnType = rg[j + 2];
        // FQN format byte at j + 3 (usually 0x00); name follows
        const nameBytes = rg.subarray(j + 4, j + tLen);
        const name = extractEbcdicName(nameBytes, 0, nameBytes.length);
        if (fqnType === 0x85) codedFontName = name;
        else if (fqnType === 0x86) characterSetName = name;
      }

      j += tLen;
    }

    if (localId !== null) {
      mappings.push({
        localId,
        codedFontName,
        characterSetName,
        bold: isBoldCharSet(characterSetName),
      });
    }

    i += rgLen;
  }

  return mappings;
}

/**
 * One MCF snapshot located at a specific byte offset in the file.
 * The page parser uses the most recent MCF before a given page offset.
 */
interface MCFSnapshot {
  offset: number;
  table: FontMappingTable;
}

// Buffer-keyed cache for MCF snapshots so we don't re-scan the file per page.
let _cachedMCFBufferSize = 0;
let _cachedMCFSnapshots: MCFSnapshot[] | null = null;

function scanMCFs(buffer: ArrayBuffer): MCFSnapshot[] {
  if (_cachedMCFBufferSize === buffer.byteLength && _cachedMCFSnapshots) {
    return _cachedMCFSnapshots;
  }
  const snapshots: MCFSnapshot[] = [];
  for (const field of iterateStructuredFields(buffer)) {
    if (field.typeId === TYPE_MCF) {
      const rows = parseMCF(field.data);
      if (rows.length > 0) {
        const table = new Map<number, FontMapping>();
        for (const row of rows) table.set(row.localId, row);
        snapshots.push({ offset: field.offset, table });
      }
    }
  }
  _cachedMCFBufferSize = buffer.byteLength;
  _cachedMCFSnapshots = snapshots;
  return snapshots;
}

/** Find the MCF snapshot most recently defined before the given page offset. */
function findFontMapForPage(
  snapshots: MCFSnapshot[],
  pageByteOffset: number,
): FontMappingTable | undefined {
  let chosen: MCFSnapshot | undefined;
  for (const snap of snapshots) {
    if (snap.offset <= pageByteOffset) chosen = snap;
    else break;
  }
  return chosen?.table;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a single AFP page from a buffer slice and produces a PageRenderTree.
 *
 * @param buffer      The full file buffer (or at least the portion containing
 *                    the page data; offsets are relative to this buffer).
 * @param byteOffset  Absolute byte offset of the BPG structured field within
 *                    the buffer.
 * @param byteLength  Number of bytes from BPG through EPG inclusive.
 * @returns A fully populated PageRenderTree.
 */
export function parsePage(
  buffer: ArrayBuffer,
  byteOffset: number,
  byteLength: number,
): PageRenderTree {
  // Parse embedded code pages and register them for EBCDIC decoding.
  try {
    const codePages = parseEmbeddedCodePages(buffer);
    for (const [name, cp] of codePages) {
      registerCodePage(name, cp.mapping);
    }
  } catch {
    // Code page parsing failure is non-fatal
  }

  // Auto-detect code page by scanning for BCP (Begin Code Page, D3A887) records.
  // If French/Italian code pages (T1001144, T10D1144) are found, use CP297.
  try {
    const TYPE_BCP = 'D3A887';
    for (const field of iterateStructuredFields(buffer)) {
      if (field.typeId === TYPE_BCP && field.data.length >= 8) {
        const cpName = extractEbcdicName(field.data, 0, 8);
        if (cpName.includes('1144') || cpName.includes('1147') || cpName.includes('297')) {
          setDefaultCodePage('cp297');
          break;
        }
      }
      if (field.typeId === TYPE_BPG) break; // stop at first page
    }
  } catch { /* non-fatal */ }

  // Pre-scan the full buffer for inline image resources
  const inlineResources = scanInlineResources(buffer);

  // Pre-scan MCF (Map Coded Font) records so the PTOCA parser can resolve
  // font local IDs (set via SCFL/0xF1) to character set names and weights.
  const mcfSnapshots = scanMCFs(buffer);
  const fontMap = findFontMapForPage(mcfSnapshots, byteOffset);

  // Pre-scan for IM Images (signatures, QR codes, overlays) — cached globally
  // Clear cache when file changes
  if (_cachedBufferSize !== buffer.byteLength) {
    _cachedIMImages = null;
    _cachedBufferSize = buffer.byteLength;
  }
  let imImages = _cachedIMImages;
  if (!imImages) {
    try {
      const parsed = parseIMImages(buffer);
      if (parsed.size > 0) {
        imImages = new Map();
        for (const [name, img] of parsed) {
          const url = renderIMImageToDataUrl(img);
          if (url) {
            imImages.set(name, { dataUrl: url, width: img.width, height: img.height, resolution: img.resolution });
          }
        }
        _cachedIMImages = imImages;
      }
    } catch { /* non-fatal */ }
  }

  // Slice the relevant portion of the buffer
  const pageBuffer = buffer.slice(byteOffset, byteOffset + byteLength);

  // Default page properties
  let pageWidth = DEFAULT_PAGE_WIDTH;
  let pageHeight = DEFAULT_PAGE_HEIGHT;
  let pageResolution = DEFAULT_RESOLUTION;
  let pageNumber = 0;
  const objects: PageObject[] = [];

  const state = freshState();
  state.fullBuffer = buffer;
  state.pageByteOffset = byteOffset;
  state.fontMap = fontMap;

  for (const field of iterateStructuredFields(pageBuffer)) {
    try {
      processField(field, state, objects, (w, h, r) => {
        pageWidth = w;
        pageHeight = h;
        pageResolution = r;
      }, (pn) => {
        pageNumber = pn;
      }, inlineResources, imImages);
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(
          `Page parser: error processing field ${field.typeId} at offset ${field.offset}:`,
          err,
        );
      }
    }
  }

  // If there is an unclosed sub-architecture at end of page, flush it
  flushCurrentArch(state, objects);

  // Use PGD dimensions directly. The PGD already specifies the correct
  // page orientation (portrait or landscape) via width/height values.
  return {
    pageNumber,
    width: pageWidth,
    height: pageHeight,
    resolution: pageResolution,
    objects,
  };
}

// ---------------------------------------------------------------------------
// Field dispatcher
// ---------------------------------------------------------------------------

/**
 * Cache for IM images decoded contextually by their BII offset.
 * Image names like "I0000001" are NOT unique across the file (the test
 * file has 13 distinct images all named "I0000001"), so a name-keyed
 * map cannot identify them. Keying by absolute byte offset is unique.
 */
interface DecodedOverlayImage {
  dataUrl: string;
  width: number;
  height: number;
  resolution: number;
}
let _overlayImageByOffset: Map<number, DecodedOverlayImage | null> | null = null;
let _overlayImageBufferSize = 0;

function getOverlayImageByOffset(
  buffer: ArrayBuffer,
  biiOffset: number,
): DecodedOverlayImage | null {
  if (_overlayImageBufferSize !== buffer.byteLength) {
    _overlayImageByOffset = null;
    _overlayImageBufferSize = buffer.byteLength;
  }
  if (!_overlayImageByOffset) _overlayImageByOffset = new Map();
  if (_overlayImageByOffset.has(biiOffset)) {
    return _overlayImageByOffset.get(biiOffset) ?? null;
  }
  const img = parseIMImageAt(buffer, biiOffset);
  if (!img) {
    _overlayImageByOffset.set(biiOffset, null);
    return null;
  }
  const dataUrl = renderIMImageToDataUrl(img);
  if (!dataUrl) {
    _overlayImageByOffset.set(biiOffset, null);
    return null;
  }
  const decoded: DecodedOverlayImage = {
    dataUrl,
    width: img.width,
    height: img.height,
    resolution: img.resolution,
  };
  _overlayImageByOffset.set(biiOffset, decoded);
  return decoded;
}

/** Cached overlay content index. */
interface OverlayContent {
  /**
   * IM images inside this overlay. Each entry tracks the BII byte offset
   * so the actual image data can be decoded contextually — image names
   * (like "I0000001") are NOT unique across the file, so we cannot rely
   * on a global name → image map.
   */
  imImages: { name: string; biiOffset: number; offsetX: number; offsetY: number }[];
  ocdChunks: Uint8Array[];
  segResolution: number;
}
let _overlayCache: Map<string, OverlayContent> | null = null;
let _overlayCacheSize = 0;

/**
 * Scans a BOC overlay container for its IM Images and GOCA graphics.
 * Overlays (referenced by IPO) contain logos and other images.
 */
function scanOverlayContent(
  buffer: ArrayBuffer,
  overlayName: string,
): OverlayContent | null {
  if (_overlayCacheSize !== buffer.byteLength) {
    _overlayCache = null;
    _overlayCacheSize = buffer.byteLength;
  }
  if (!_overlayCache) {
    _overlayCache = new Map();
    // Build cache: scan all BOC containers for overlay content (BOV)
    let inOverlay = false;
    let bocName = '';
    let ocdChunks: Uint8Array[] = [];
    let imRefs: { name: string; biiOffset: number; offsetX: number; offsetY: number }[] = [];
    let segRes = 300;

    const TYPE_BOV_ID = 'D3A8DF';
    const TYPE_EOV_ID = 'D3A9DF';
    const TYPE_BII_PS = 'D3A8FB';
    const TYPE_GDD_ID = 'D3A66B';

    for (const field of iterateStructuredFields(buffer)) {
      if (field.typeId === TYPE_BOC && field.data.length >= 8) {
        bocName = extractEbcdicName(field.data, 0, 8);
      }
      if (field.typeId === TYPE_BOV_ID) {
        inOverlay = true;
        ocdChunks = [];
        imRefs = [];
        segRes = 300;
      }
      if (field.typeId === TYPE_GDD_ID && inOverlay && field.data.length >= 9) {
        const d = field.data;
        for (let i = 2; i < d.length - 3; i++) {
          const v1 = (d[i] << 8) | d[i + 1];
          const v2 = (d[i + 2] << 8) | d[i + 3];
          if (v1 === v2 && v1 >= 720 && v1 <= 14400) { segRes = v1 / 10; break; }
        }
      }
      if (field.typeId === TYPE_OCD && inOverlay && field.data.length > 0) {
        ocdChunks.push(field.data.slice());
      }
      if (field.typeId === TYPE_BII_PS && inOverlay && field.data.length >= 8) {
        imRefs.push({
          name: extractEbcdicName(field.data, 0, 8),
          biiOffset: field.offset,
          offsetX: 0,
          offsetY: 0,
        });
      }
      if (field.typeId === TYPE_EOV_ID && inOverlay) {
        if (bocName && (ocdChunks.length > 0 || imRefs.length > 0)) {
          _overlayCache!.set(bocName, {
            imImages: imRefs,
            ocdChunks: [...ocdChunks],
            segResolution: segRes,
          });
        }
        inOverlay = false;
      }
      if (field.typeId === TYPE_BPG) break;
    }
  }

  return _overlayCache.get(overlayName) ?? null;
}

/**
 * Extracts GOCA drawing orders from OCD chunks (stripping cell headers)
 * and pushes a graphics PageObject if orders are found.
 * Returns true if a graphics object was created.
 */
function tryRenderGOCASegment(
  ocdChunks: Uint8Array[],
  x: number,
  y: number,
  objects: PageObject[],
  segResolution: number = 300,
  pageResolution: number = DEFAULT_RESOLUTION,
  flipX: boolean = false,
  resourceName?: string,
): boolean {
  const rawChunks: Uint8Array[] = [];
  for (const chunk of ocdChunks) {
    if (chunk.length === 0) continue;
    let start = 0;
    if (chunk[0] === 0x70) {
      const cellLen = chunk.length > 1 ? chunk[1] : 0;
      start = 2 + cellLen;
      // Skip any SDFs in the cell-header preamble. SDFs use the
      // [id][lengthByte][data...] format where lengthByte is the *data*
      // length (NOT including id+lengthByte), so the total span is
      // sdLen + 2 bytes. Advancing by only sdLen leaves the last 2
      // bytes of SDF data dangling, which the GOCA parser then
      // misinterprets as a stray long-form order — corrupting the
      // entire drawing stream (this manifested as a stray diagonal
      // line through the VISECA logo, see GOCA SDF skip bug).
      while (start < Math.min(chunk.length, 200)) {
        const b = chunk[start];
        if (b === 0x00) { start++; continue; }
        if (b >= 0xA0 && b <= 0xBF && start + 1 < chunk.length) {
          const sdLen = chunk[start + 1];
          if (sdLen > 0 && start + 2 + sdLen <= chunk.length) {
            start += sdLen + 2;
            continue;
          }
        }
        break;
      }
    }
    if (start < chunk.length) rawChunks.push(chunk.slice(start));
  }

  if (rawChunks.length === 0) return false;

  const totalLen = rawChunks.reduce((s, c) => s + c.length, 0);
  const allData = new Uint8Array(totalLen);
  let off = 0;
  for (const c of rawChunks) { allData.set(c, off); off += c.length; }

  const orders = parseGOCAOrders(allData);
  if (orders.length === 0) return false;

  // GOCA coordinates are in segment resolution (typically 300/inch).
  // Page coordinates are in page resolution (could be 300 or 1440/inch).
  // Scale factor to convert segment coords to page L-units.
  const coordScale = pageResolution / segResolution; // e.g., 300/300 = 1.0 or 1440/300 = 4.8

  const bounds = computeGOCABounds(orders);
  const scaledW = bounds ? Math.round(bounds.width * coordScale) : 3000;
  const scaledH = bounds ? Math.round(bounds.height * coordScale) : 3000;

  objects.push({
    kind: 'graphics',
    x,
    y,
    width: scaledW,
    height: scaledH,
    resourceName,
    graphics: { orders, data: allData, bounds, coordinateScale: coordScale, flipX },
  });
  return true;
}

/** Global index of ALL GOCA page segment copies, keyed by name → array of {offset, ocdChunks}. */
interface SegmentCopy { offset: number; ocdChunks: Uint8Array[]; segResolution: number; }
let _allSegmentCopies: Map<string, SegmentCopy[]> | null = null;
let _allSegCopiesSize = 0;

/**
 * Builds a full index of ALL page segment copies in the file.
 * Keys segments by BOTH their BPS name AND their parent BOC container name.
 * BOC names are unique per page (e.g., SAAAAAAA, SAAAAAAB) while BPS names
 * may repeat across pages (e.g., S{000001 appears 208 times).
 */
function indexAllSegmentCopies(buffer: ArrayBuffer): Map<string, SegmentCopy[]> {
  const index = new Map<string, SegmentCopy[]>();
  let inSeg = false;
  let segName = '';
  let bocName = '';
  let segOffset = 0;
  let ocdChunks: Uint8Array[] = [];
  let segResolution = 300; // default: 3000 per 10 inches = 300/inch

  const TYPE_GDD = 'D3A66B'; // Graphics Data Descriptor

  for (const field of iterateStructuredFields(buffer)) {
    if (field.typeId === TYPE_BOC && field.data.length >= 8) {
      bocName = extractEbcdicName(field.data, 0, 8);
    }
    // Parse GDD to extract segment resolution
    if (field.typeId === TYPE_GDD && field.data.length >= 9) {
      // GDD format: [flags][type][...] then xRes:2, yRes:2 at a variable offset.
      // The resolution appears as a pair of identical 2-byte values (xRes == yRes).
      // Scan for two consecutive identical values in the 720-14400 range.
      const d = field.data;
      for (let i = 2; i < d.length - 3; i++) {
        const v1 = (d[i] << 8) | d[i + 1];
        const v2 = (d[i + 2] << 8) | d[i + 3];
        if (v1 === v2 && v1 >= 720 && v1 <= 14400) {
          segResolution = v1 / 10; // convert from per-10-inches to per-inch
          break;
        }
      }
    }
    if (field.typeId === TYPE_BPS) {
      inSeg = true;
      segOffset = field.offset;
      ocdChunks = [];
      segName = field.data.length >= 8 ? extractEbcdicName(field.data, 0, 8) : '';
    } else if (field.typeId === TYPE_OCD && inSeg) {
      if (field.data.length > 0) ocdChunks.push(field.data.slice());
    } else if (field.typeId === TYPE_EPS && inSeg) {
      if (ocdChunks.length > 0) {
        const copy = { offset: segOffset, ocdChunks: [...ocdChunks], segResolution };
        if (segName) {
          let arr = index.get(segName);
          if (!arr) { arr = []; index.set(segName, arr); }
          arr.push(copy);
        }
        if (bocName && bocName !== segName) {
          let arr = index.get(bocName);
          if (!arr) { arr = []; index.set(bocName, arr); }
          arr.push(copy);
        }
      }
      inSeg = false;
    }
    if (field.typeId === TYPE_BPG) break;
  }
  return index;
}

/**
 * Finds the GOCA page segment for a given IPS reference.
 * Returns the OCD chunks and segment resolution.
 */
function findSegmentForPage(
  buffer: ArrayBuffer,
  segName: string,
  _pageOffset: number,
): { ocdChunks: Uint8Array[]; segResolution: number } | null {
  if (_allSegCopiesSize !== buffer.byteLength) {
    _allSegmentCopies = null;
    _allSegCopiesSize = buffer.byteLength;
  }
  if (!_allSegmentCopies) {
    _allSegmentCopies = indexAllSegmentCopies(buffer);
  }

  const copies = _allSegmentCopies.get(segName);
  if (copies && copies.length > 0) {
    return { ocdChunks: copies[0].ocdChunks, segResolution: copies[0].segResolution };
  }

  return null;
}

function processField(
  field: AFPStructuredField,
  state: ParseState,
  objects: PageObject[],
  setPageDimensions: (w: number, h: number, r: number) => void,
  setPageNumber: (n: number) => void,
  inlineResources?: Map<string, InlineResource>,
  imImages?: Map<string, { dataUrl: string; width: number; height: number; resolution: number }> | null,
): void {
  switch (field.typeId) {
    // ----- Page-level fields -----

    case TYPE_BPG: {
      // BPG data may contain a page name (8 bytes EBCDIC) and page number.
      // We extract the page sequence number if present in triplets.
      if (field.data.length >= 8) {
        // Try to extract the page number from the data portion.
        // The BPG data payload starts with an 8-byte page name, followed
        // by optional triplets.  We don't strictly need the page number
        // here (the caller usually knows it), but we attempt to extract it
        // for completeness.
        const tripletOffset = 8;
        const pn = extractPageNumberFromTriplets(field.data, tripletOffset);
        if (pn > 0) setPageNumber(pn);
      }
      break;
    }

    case TYPE_PGD: {
      const desc = parsePageDescriptor(field.data);
      setPageDimensions(desc.width, desc.height, desc.resolution);
      state.pageResolution = desc.resolution;
      break;
    }

    // ----- Object area position -----

    case TYPE_OBP: {
      parseObjectAreaPosition(field.data, state);
      break;
    }

    // ----- Presentation Text sub-architecture -----

    case TYPE_BPT:
    case TYPE_BPT_ALT: {
      flushCurrentArch(state, objects);
      state.currentArch = 'text';
      state.ptxChunks = [];
      // Note: applyOverlayOffset persists until next IPO or IPS clears it
      break;
    }

    case TYPE_PTD: {
      // Presentation Text Descriptor — mostly informational.
      break;
    }

    case TYPE_PTX:
    case TYPE_PTX_STD: {
      // Accumulate presentation text data
      if (state.currentArch === 'text' && field.data.length > 0) {
        state.ptxChunks.push(field.data.slice());
      } else if (field.data.length > 0) {
        // PTX found outside BPT/EPT — auto-enter text mode
        if (state.currentArch !== 'text') {
          flushCurrentArch(state, objects);
          state.currentArch = 'text';
          state.ptxChunks = [];
        }
        state.ptxChunks.push(field.data.slice());
      }
      break;
    }

    case TYPE_EPT:
    case TYPE_EPT_ALT: {
      if (state.currentArch === 'text') {
        finalizeTextObject(state, objects);
        state.currentArch = null;
      }
      break;
    }

    // ----- Image sub-architecture -----

    case TYPE_BIM: {
      flushCurrentArch(state, objects);
      state.currentArch = 'image';
      state.imageDescriptor = {};
      state.ideChunks = [];
      break;
    }

    case TYPE_IDD: {
      if (state.currentArch === 'image') {
        state.imageDescriptor = parseImageDescriptor(field.data);
      }
      break;
    }

    case TYPE_IDE: {
      if (state.currentArch === 'image' && field.data.length > 0) {
        state.ideChunks.push(field.data.slice());
      }
      break;
    }

    case TYPE_EIM: {
      if (state.currentArch === 'image') {
        finalizeImageObject(state, objects);
        state.currentArch = null;
      }
      break;
    }

    // ----- IM Image (older format, D3A892/D3EE92/D3A992) -----

    case TYPE_BII: {
      flushCurrentArch(state, objects);
      state.currentArch = 'image';
      state.imageDescriptor = {};
      state.ideChunks = [];
      // BII data contains image descriptor info
      if (field.data.length >= 8) {
        // Parse IM Image descriptor from BII data:
        // bytes 0-7: name, then resolution and dimension info
        // bytes after name may contain: resolution, dimensions
        const imgData = field.data;
        if (imgData.length >= 16) {
          const hRes = readU16(imgData, 8);
          const vRes = readU16(imgData, 10);
          const w = readU16(imgData, 12);
          const h = readU16(imgData, 14);
          if (w > 0 && h > 0) {
            state.imageDescriptor = {
              width: w,
              height: h,
              xResolution: hRes || 96,
              yResolution: vRes || 96,
              compression: IOCACompression.JPEG,
              colorModel: IOCAColorModel.RGB,
              bitDepth: 24,
              data: new Uint8Array(0),
            };
          }
        }
      }
      break;
    }

    case TYPE_IID: {
      // IM Image Data — raw image bytes (often JPEG)
      if (field.data.length > 0) {
        if (state.currentArch !== 'image') {
          flushCurrentArch(state, objects);
          state.currentArch = 'image';
          state.imageDescriptor = {};
          state.ideChunks = [];
        }
        // Check if data starts with JPEG SOI marker (FFD8)
        if (field.data.length >= 2 && field.data[0] === 0xFF && field.data[1] === 0xD8) {
          state.imageDescriptor.compression = IOCACompression.JPEG;
        }
        state.ideChunks.push(field.data.slice());
      }
      break;
    }

    case TYPE_EII: {
      if (state.currentArch === 'image') {
        finalizeImageObject(state, objects);
        state.currentArch = null;
      }
      break;
    }

    // ----- Include Object (IOC) — references an inline resource -----

    case TYPE_IOC: {
      // Include Object — references an inline resource by name.
      if (field.data.length >= 8 && inlineResources) {
        const resName = extractEbcdicName(field.data, 0, 8);
        const resource = inlineResources.get(resName);
        if (resource) {
          // Extract position from IOC triplet data
          // Search for X/Y position values in the IOC data
          let imgX = state.objectX;
          const imgY = state.objectY;

          // Scan IOC data for position-like values
          // The IOC data after the 8-byte name contains structured triplets
          // with position info. Search for 3-byte values that match
          // reasonable page positions.
          const iocParams = field.data.slice(8);
          for (let k = 0; k + 2 < iocParams.length; k++) {
            const val3 = (iocParams[k] << 16) | (iocParams[k + 1] << 8) | iocParams[k + 2];
            const inches = val3 / 1440;
            // Look for X position (6-9 inches = right side of page)
            if (inches > 6.0 && inches < 9.0 && imgX === 0) {
              imgX = val3;
            }
          }
          // If no X found from triplets, use a default right-aligned position
          if (imgX === 0) imgX = 11520; // 8.0 inches

          // Create image object
          const imgObj: IOCAImageObject = {
            width: 159,
            height: 48,
            xResolution: 96,
            yResolution: 96,
            bitDepth: 24,
            compression: resource.isJpeg ? IOCACompression.JPEG : IOCACompression.None,
            colorModel: IOCAColorModel.RGB,
            data: resource.data,
          };

          objects.push({
            kind: 'image',
            x: imgX,
            y: imgY || 270, // default ~0.19 inches from top
            width: 2380, // ~1.65 inches
            height: 720, // ~0.5 inches
            image: imgObj,
          });
        }
      }
      break;
    }

    // ----- Document/Resource boundaries (treated as no-ops during page parse) -----

    case TYPE_IPO: {
      // Include Page Overlay — renders overlay content (logos, images, graphics)
      // Data: 8-byte overlay name + position (X:3, Y:3)
      if (field.data.length >= 14) {
        const overlayName = extractEbcdicName(field.data, 0, 8);
        const posData = field.data.slice(8);
        let ipoX = 0;
        let ipoY = 0;
        if (posData.length >= 6) {
          ipoX = (posData[0] << 16) | (posData[1] << 8) | posData[2];
          ipoY = (posData[3] << 16) | (posData[4] << 8) | posData[5];
        }

        // Set overlay offset for subsequent text positioning.
        // Text after an IPO uses coordinates relative to the overlay origin.
        state.overlayOffsetX = ipoX;
        state.overlayOffsetY = ipoY;

        // Render overlay images: scan the overlay BOC for IM Images and GOCA
        if (state.fullBuffer) {
          const overlayContent = scanOverlayContent(state.fullBuffer, overlayName);
          if (overlayContent) {
            // Render IM Images from the overlay. Decode them contextually
            // by BII byte offset — image names ("I0000001") are NOT unique
            // across the file and a name-keyed lookup returns the wrong
            // image (causing the jumbo logo to be missing or replaced
            // with a tiny duplicate).
            for (const img of overlayContent.imImages) {
              const decoded = state.fullBuffer
                ? getOverlayImageByOffset(state.fullBuffer, img.biiOffset)
                : null;
              if (decoded) {
                objects.push({
                  kind: 'image',
                  x: ipoX + img.offsetX,
                  y: ipoY + img.offsetY,
                  width: Math.round(decoded.width * state.pageResolution / decoded.resolution),
                  height: Math.round(decoded.height * state.pageResolution / decoded.resolution),
                  resourceName: overlayName,
                  image: {
                    width: decoded.width,
                    height: decoded.height,
                    xResolution: decoded.resolution,
                    yResolution: decoded.resolution,
                    bitDepth: 1,
                    compression: IOCACompression.None,
                    colorModel: IOCAColorModel.BiLevel,
                    data: new Uint8Array(0),
                  },
                  _dataUrl: decoded.dataUrl,
                } as PageObject & { _dataUrl?: string });
              }
            }
            // Render GOCA graphics from the overlay (skip small form elements)
            if (overlayContent.ocdChunks.length > 0) {
              // Only render if OCD has substantial content (> 1000 bytes).
              // Small OCD is typically form decoration (lines, boxes) or
              // background rectangles that overlap with page content.
              // Real logos/graphics have thousands of bytes of vector data.
              const ocdTotalLen = overlayContent.ocdChunks.reduce((s, c) => s + c.length, 0);
              if (ocdTotalLen > 1000) {
                tryRenderGOCASegment(
                  overlayContent.ocdChunks, ipoX, ipoY, objects,
                  overlayContent.segResolution, state.pageResolution,
                  true, // overlay GOCA uses Y-flipped axis
                  overlayName,
                );
              }
            }
          }
        }
      }
      break;
    }

    case 'D3AF5F': { // IPS — Include Page Segment
      if (field.data.length >= 8) {
        const segName = extractEbcdicName(field.data, 0, 8);

        // Extract position from IPS data (bytes 8+: X:3, Y:3)
        let ipsX = 0;
        let ipsY = 0;
        if (field.data.length >= 14) {
          ipsX = (field.data[8] << 16) | (field.data[9] << 8) | field.data[10];
          ipsY = (field.data[11] << 16) | (field.data[12] << 8) | field.data[13];
        }

        let handled = false;

        // Try IM Image lookup first
        const imgData = imImages?.get(segName);
        if (imgData) {
          // Convert image pel dimensions (at its own DPI) to page L-units
          // so the renderer's scaleFactor produces the correct physical size.
          // Example: a 590-pel logo at 300 dpi on a 1440 L-unit/inch page
          // becomes 590 * 1440/300 = 2832 L-units wide (= 1.97").
          objects.push({
            kind: 'image',
            x: ipsX,
            y: ipsY,
            width: Math.round(imgData.width * state.pageResolution / imgData.resolution),
            height: Math.round(imgData.height * state.pageResolution / imgData.resolution),
            resourceName: segName,
            image: {
              width: imgData.width,
              height: imgData.height,
              xResolution: imgData.resolution,
              yResolution: imgData.resolution,
              bitDepth: 1,
              compression: IOCACompression.None,
              colorModel: IOCAColorModel.BiLevel,
              data: new Uint8Array(0),
            },
            _dataUrl: imgData.dataUrl,
          } as PageObject & { _dataUrl?: string });
          handled = true;
        }

        // Try GOCA page segment lookup (handles exact names, MPS aliases,
        // and per-page resource copies with sequential indexing)
        if (!handled && state.fullBuffer) {
          const segResult = findSegmentForPage(state.fullBuffer, segName, state.pageByteOffset);
          if (segResult) {
            handled = tryRenderGOCASegment(segResult.ocdChunks, ipsX, ipsY, objects, segResult.segResolution, state.pageResolution, false, segName);
          }
        }
      }
      break;
    }

    case TYPE_BDT:
    case TYPE_BAG:
    case TYPE_MCF: {
      break;
    }

    case TYPE_BRS: {
      // New resource set — reset overlay offset.
      state.overlayOffsetX = 0;
      state.overlayOffsetY = 0;
      break;
    }

    // ----- Graphics sub-architecture -----

    case TYPE_BGR: {
      flushCurrentArch(state, objects);
      state.currentArch = 'graphics';
      state.gadChunks = [];
      break;
    }

    case TYPE_GAD: {
      if (state.currentArch === 'graphics' && field.data.length > 0) {
        state.gadChunks.push(field.data.slice());
      }
      break;
    }

    case TYPE_EGR: {
      if (state.currentArch === 'graphics') {
        finalizeGraphicsObject(state, objects);
        state.currentArch = null;
      }
      break;
    }

    // ----- Bar code sub-architecture -----

    case TYPE_BBC: {
      flushCurrentArch(state, objects);
      state.currentArch = 'barcode';
      state.barcodeDescriptor = {};
      state.barcodeDataChunks = [];
      break;
    }

    case TYPE_BDD: {
      if (state.currentArch === 'barcode') {
        state.barcodeDescriptor = parseBarcodeDescriptor(field.data);
      }
      break;
    }

    case TYPE_EBC: {
      if (state.currentArch === 'barcode') {
        finalizeBarcodeObject(state, objects);
        state.currentArch = null;
      }
      break;
    }

    default: {
      // For any unrecognized field inside a barcode sub-arch, treat its
      // data as barcode data (some AFP generators use non-standard fields
      // for the barcode content).
      if (state.currentArch === 'barcode' && field.data.length > 0) {
        // Only collect data from fields that are clearly content carriers
        // (we avoid collecting random structured field headers).
        // A heuristic: if the typeId starts with D3EE (data field), collect it.
        if (field.typeId.startsWith('D3EE')) {
          state.barcodeDataChunks.push(field.data.slice());
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Object finalizers
// ---------------------------------------------------------------------------

/**
 * Flush whichever sub-architecture is currently open. Called when a new
 * sub-architecture begins or when the page ends.
 */
function flushCurrentArch(state: ParseState, objects: PageObject[]): void {
  switch (state.currentArch) {
    case 'text':
      finalizeTextObject(state, objects);
      break;
    case 'image':
      finalizeImageObject(state, objects);
      break;
    case 'graphics':
      finalizeGraphicsObject(state, objects);
      break;
    case 'barcode':
      finalizeBarcodeObject(state, objects);
      break;
    default:
      break;
  }
  state.currentArch = null;
}

/** Finalize a text object from accumulated PTX chunks. */
function finalizeTextObject(state: ParseState, objects: PageObject[]): void {
  if (state.ptxChunks.length === 0) return;

  const allData = concatChunks(state.ptxChunks);
  const textObj = parsePTOCA(allData, state.fontMap);

  if (textObj.runs.length === 0) return;

  objects.push({
    kind: 'text',
    x: state.objectX,
    y: state.objectY,
    width: textObj.bounds.width > 0 ? textObj.bounds.width : state.objectWidth,
    height: textObj.bounds.height > 0 ? textObj.bounds.height : state.objectHeight,
    text: textObj,
  });

  state.ptxChunks = [];
}

/** Finalize an image object from descriptor + IDE data chunks. */
function finalizeImageObject(state: ParseState, objects: PageObject[]): void {
  const imageData = concatChunks(state.ideChunks);
  const desc = state.imageDescriptor;

  const imgWidth = desc.width ?? 1;
  const imgHeight = desc.height ?? 1;

  const imageObj: IOCAImageObject = {
    width: imgWidth,
    height: imgHeight,
    xResolution: desc.xResolution ?? 1440,
    yResolution: desc.yResolution ?? 1440,
    bitDepth: desc.bitDepth ?? 1,
    compression: desc.compression ?? IOCACompression.None,
    colorModel: desc.colorModel ?? IOCAColorModel.BiLevel,
    data: imageData,
  };

  objects.push({
    kind: 'image',
    x: state.objectX,
    y: state.objectY,
    width: state.objectWidth > 0 ? state.objectWidth : imgWidth,
    height: state.objectHeight > 0 ? state.objectHeight : imgHeight,
    image: imageObj,
  });

  state.imageDescriptor = {};
  state.ideChunks = [];
}

/** Finalize a graphics object from accumulated GAD chunks. */
function finalizeGraphicsObject(state: ParseState, objects: PageObject[]): void {
  const allData = concatChunks(state.gadChunks);
  if (allData.length === 0) return;

  const orders = parseGOCAOrders(allData);

  // Compute bounding box from the drawing orders
  const bounds = computeGOCABounds(orders);

  const gocaObj: GOCAObject = {
    orders,
    data: allData,
    bounds,
  };

  objects.push({
    kind: 'graphics',
    x: state.objectX,
    y: state.objectY,
    width: bounds ? bounds.width : state.objectWidth,
    height: bounds ? bounds.height : state.objectHeight,
    graphics: gocaObj,
  });

  state.gadChunks = [];
}

/** Finalize a barcode object from descriptor + data chunks. */
function finalizeBarcodeObject(state: ParseState, objects: PageObject[]): void {
  const rawData = concatChunks(state.barcodeDataChunks);
  const desc = state.barcodeDescriptor;

  // Decode barcode data — try EBCDIC first, then fall back to raw ASCII
  let decodedData: string;
  if (rawData.length > 0) {
    try {
      decodedData = ebcdicToUnicode(rawData);
      // Filter out control characters
      decodedData = decodedData.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    } catch {
      // Fall back to simple ASCII interpretation
      decodedData = String.fromCharCode(...rawData.filter(b => b >= 0x20 && b <= 0x7E));
    }
  } else {
    decodedData = '';
  }

  if (decodedData.length === 0 && rawData.length === 0) return;

  const barcodeObj: BCOCAObject = {
    barcodeType: desc.barcodeType ?? BarcodeType.Code128,
    data: decodedData,
    rawData,
    moduleWidth: desc.moduleWidth ?? 10,
    barHeight: desc.barHeight ?? 720,
    color: desc.color ?? { r: 0, g: 0, b: 0, a: 255 },
    humanReadable: desc.humanReadable ?? true,
    orientation: desc.orientation ?? 0,
    x: desc.x ?? 0,
    y: desc.y ?? 0,
  };

  objects.push({
    kind: 'barcode',
    x: state.objectX,
    y: state.objectY,
    width: state.objectWidth > 0 ? state.objectWidth : 2880, // 2" default
    height: state.objectHeight > 0 ? state.objectHeight : 1440, // 1" default
    barcode: barcodeObj,
  });

  state.barcodeDescriptor = {};
  state.barcodeDataChunks = [];
}

// ---------------------------------------------------------------------------
// Page Descriptor parser
// ---------------------------------------------------------------------------

/**
 * Parses a PGD (Page Descriptor, D3A6AF) structured field data payload to
 * extract page dimensions and resolution.
 *
 * PGD data layout (typical):
 *   Byte 0:      Unit base (0x00 = 10 inches)
 *   Bytes 1-2:   X-axis units per unit base (big-endian 16-bit)
 *   Bytes 3-4:   Y-axis units per unit base (big-endian 16-bit)
 *   Bytes 5-7:   Page width in L-units (big-endian 24-bit)
 *   Bytes 8-10:  Page height in L-units (big-endian 24-bit)
 *
 * If data is too short, defaults are returned.
 */
export function parsePageDescriptor(
  data: Uint8Array,
): { width: number; height: number; resolution: number } {
  const defaults = {
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
    resolution: DEFAULT_RESOLUTION,
  };

  if (data.length < 11) return defaults;

  // PGD data layout (from AFP analysis):
  // Bytes 0-1: reserved/flags
  // Bytes 2-3: X resolution (units per 10 inches, big-endian)
  // Bytes 4-5: Y resolution (units per 10 inches, big-endian)
  // Bytes 6-8: Page width (3 bytes big-endian, in L-units)
  // Bytes 9-11: Page height (3 bytes big-endian, in L-units)

  const unitBase = data[0];
  const xUnitsPerBase = readU16(data, 2);
  const _yUnitsPerBase = readU16(data, 4);

  const pageWidth = readU24(data, 6);
  const pageHeight = readU24(data, 9);

  // Determine resolution in L-units per inch.
  // If unit base is 0x00, resolution = unitsPerBase / 10.
  // However, in most AFP documents the resolution values are already
  // L-units per inch (1440 being the most common).
  let resolution: number;
  if (unitBase === 0x00 && xUnitsPerBase > 0) {
    // Unit base = 10 inches
    resolution = Math.round(xUnitsPerBase / 10);
    // Sanity check: if resolution came out unreasonably small, use the
    // raw value (some generators store L-units/inch directly).
    if (resolution < 72) {
      resolution = xUnitsPerBase;
    }
  } else if (xUnitsPerBase > 0) {
    resolution = xUnitsPerBase;
  } else {
    resolution = DEFAULT_RESOLUTION;
  }

  // Validate dimensions — a page of 0 dimensions is not useful
  const finalWidth = pageWidth > 0 ? pageWidth : defaults.width;
  const finalHeight = pageHeight > 0 ? pageHeight : defaults.height;
  const finalResolution = resolution > 0 ? resolution : defaults.resolution;

  return {
    width: finalWidth,
    height: finalHeight,
    resolution: finalResolution,
  };
}

// ---------------------------------------------------------------------------
// Image Data Descriptor parser
// ---------------------------------------------------------------------------

/**
 * Parses an IDD (Image Data Descriptor, D3ACCE) structured field data payload
 * to extract image metadata: dimensions, resolution, compression, colour model,
 * and bit depth.
 *
 * The IDD contains Self-Defining Fields (SDFs). The layout varies, but a
 * typical IDD contains:
 *   Bytes 0-1:   Unit base (similar to PGD)
 *   Bytes 2-3:   X resolution (units per unit base)
 *   Bytes 4-5:   Y resolution (units per unit base)
 *
 * After the fixed header, the remainder consists of Self-Defining Fields (SDFs)
 * chained as: [length:1][id:1][data:variable].
 *
 * Key SDFs:
 *   0x94 / 0x9B — Image Size Parameter
 *     Byte 0:    SDF length (including length + id bytes)
 *     Byte 1:    SDF ID (0x94 or 0x9B)
 *     Bytes 2-3: Horizontal image size in pels (pixels)
 *     Bytes 4-5: Vertical image size in pels
 *     Bytes 6-7: Horizontal resolution
 *     Bytes 8-9: Vertical resolution
 *
 *   0x95 — Image Encoding Parameter
 *     Contains compression algorithm ID.
 *
 *   0x96 — IDE Size Parameter
 *     Contains bits per IDE (bit depth).
 */
export function parseImageDescriptor(
  data: Uint8Array,
): Partial<IOCAImageObject> {
  const result: Partial<IOCAImageObject> = {};

  if (data.length < 2) return result;

  // Read the fixed header portion (first 6 bytes if present)
  // Some IDD fields have a short header; handle gracefully.
  let sdfStart = 0;

  if (data.length >= 6) {
    // Bytes 0-1: unit base indicator
    // Bytes 2-3: X resolution
    // Bytes 4-5: Y resolution
    const xRes = readU16(data, 2);
    const yRes = readU16(data, 4);
    if (xRes > 0) result.xResolution = xRes;
    if (yRes > 0) result.yResolution = yRes;
    sdfStart = 6;
  }

  // Parse Self-Defining Fields
  let offset = sdfStart;
  while (offset + 2 <= data.length) {
    const sdfLength = data[offset];
    const sdfId = data[offset + 1];

    // Validate SDF length
    if (sdfLength < 2 || offset + sdfLength > data.length) break;

    switch (sdfId) {
      case 0x94:
      case 0x9B: {
        // Image Size Parameter
        if (sdfLength >= 10) {
          const hSize = readU16(data, offset + 2);
          const vSize = readU16(data, offset + 4);
          const hRes = readU16(data, offset + 6);
          const vRes = readU16(data, offset + 8);

          if (hSize > 0) result.width = hSize;
          if (vSize > 0) result.height = vSize;
          if (hRes > 0) result.xResolution = hRes;
          if (vRes > 0) result.yResolution = vRes;
        } else if (sdfLength >= 6) {
          // Short form: just dimensions
          const hSize = readU16(data, offset + 2);
          const vSize = readU16(data, offset + 4);
          if (hSize > 0) result.width = hSize;
          if (vSize > 0) result.height = vSize;
        }
        break;
      }

      case 0x95: {
        // Image Encoding Parameter — compression algorithm
        if (sdfLength >= 3) {
          const compressionId = data[offset + 2];
          result.compression = mapCompressionId(compressionId);
        }
        break;
      }

      case 0x96: {
        // IDE Size Parameter — bits per IDE
        if (sdfLength >= 3) {
          result.bitDepth = data[offset + 2];
        }
        break;
      }

      case 0x97: {
        // IDE Structure Parameter — colour model
        if (sdfLength >= 4) {
          // Byte 2 = flags, Byte 3 = colour model
          const colorModelByte = data[offset + 3];
          result.colorModel = mapColorModel(colorModelByte);
        } else if (sdfLength >= 3) {
          result.colorModel = mapColorModel(data[offset + 2]);
        }
        break;
      }

      default:
        // Unknown SDF — skip
        break;
    }

    offset += sdfLength;
  }

  // If no explicit dimensions were found from SDFs, try to infer them from
  // the data size and bit depth.
  if (!result.width && !result.height && data.length > sdfStart) {
    // Cannot reliably infer — leave undefined
  }

  return result;
}

// ---------------------------------------------------------------------------
// GOCA Drawing Order parser
// ---------------------------------------------------------------------------

/**
 * Known GOCA drawing order sizes. For variable-length orders, -1 indicates
 * that the length is encoded in the data following the order byte.
 *
 * Order types 0x00-0x7F are "short form" (1-byte order code, parameters
 * determined by order type). Order types 0x80-0xFE are "long form" with a
 * 2-byte length field after the order code.
 */
const GOCA_ORDER_SIZES: Record<number, number> = {
  // No-operation / control
  0x00: 0,  // GNOP — No Operation
  0x01: 0,  // GNOP1 — No Operation (variant)

  // State-setting orders (short, fixed size)
  0x04: 1,  // GSCMP — Set Character Mode Precision
  0x08: 1,  // GSCOL — Set Color (index)
  0x0A: 1,  // GSMX — Set Mix
  0x0B: 1,  // GSBMX — Set Background Mix
  0x0C: 2,  // GSCC — Set Character Cell (W, H bytes)
  0x11: 4,  // GSFLW — Set Fractional Line Width
  0x18: 1,  // GSLT — Set Line Type
  0x19: 2,  // GSLW — Set Line Width
  0x26: 1,  // GSMC — Set Marker Cell
  0x29: 1,  // GSMK — Set Marker Symbol
  0x33: 4,  // GSCA — Set Character Angle (X:2, Y:2)
  0x34: 2,  // GSCS — Set Character Shear (X:1, Y:1)
  0x35: 0,  // GSCR — Set Character Direction (no params)
  0x37: 4,  // GSCH — Set Character Height
  0x39: 2,  // GSMP — Set Marker Precision

  // Position orders (length-byte format: code + lengthByte + params)
  0x21: -1, // GSCP — Set Current Position; uses length byte like long-form

  // Area boundary orders
  0x68: 1,  // GBAREA — Begin Area (1 flag byte)
  0x60: 1,  // GEAREA — End Area (1 flag byte)

  // Image / character orders
  0x70: 0,  // GBIMG — Begin Image at Given (consumed as cell marker, shouldn't appear)
  0x71: 0,  // GEIMG — End Image
  0x72: -1, // GIMD — Image Data (variable, use next byte as length)
  0x3C: 1,  // GSCD — Set Character Direction
};

/**
 * Parses raw GOCA data bytes into an array of GOCADrawingOrder.
 *
 * Each drawing order begins with an order code byte. The parameter length
 * depends on the order type:
 * - For "short form" orders (code < 0x80): fixed parameter lengths from
 *   the known order table, or 0 if unknown.
 * - For "long form" orders (code >= 0x80): the next 2 bytes give the total
 *   length of the order (including the code byte), so parameter length =
 *   totalLength - 1.
 * - Special case: codes 0xFE (GESD) and 0xFF (unused) are segment delimiters.
 */
export function parseGOCAOrders(data: Uint8Array): GOCADrawingOrder[] {
  const orders: GOCADrawingOrder[] = [];
  let offset = 0;

  while (offset < data.length) {
    const orderCode = data[offset];

    // End of segment / padding
    if (orderCode === 0x00) {
      offset++;
      continue;
    }

    // Segment escape
    if (orderCode === 0xFE || orderCode === 0xFF) {
      offset++;
      continue;
    }

    // Determine parameter length
    let paramLength: number;

    if (orderCode >= 0x80) {
      // Long-form order: next byte is the length of the entire order
      // (including order code byte itself) for some orders, or a fixed
      // count for others.
      if (offset + 1 >= data.length) break;

      const lengthByte = data[offset + 1];

      // Check if this is a known fixed-size long order
      const knownSize = GOCA_ORDER_SIZES[orderCode];
      if (knownSize !== undefined) {
        paramLength = knownSize;
        offset++; // skip order code
      } else {
        // Length byte indicates total parameter bytes
        paramLength = lengthByte;
        offset += 2; // skip order code + length byte
      }
    } else {
      // Short-form order
      const knownSize = GOCA_ORDER_SIZES[orderCode];
      if (knownSize === -1) {
        // Length-byte format: order code + length byte + params (like long-form)
        if (offset + 1 >= data.length) break;
        paramLength = data[offset + 1];
        offset += 2; // skip order code + length byte
      } else if (knownSize !== undefined) {
        paramLength = knownSize;
        offset++; // skip order code
      } else {
        // Unknown short order — skip just the order byte (0 params)
        paramLength = 0;
        offset++; // skip order code
      }
    }

    // Clamp parameter length to available data
    paramLength = Math.min(paramLength, data.length - offset);
    if (paramLength < 0) paramLength = 0;

    // Extract parameters
    const params: number[] = [];
    for (let i = 0; i < paramLength; i++) {
      params.push(data[offset + i]);
    }

    // Map the order code to a known type, or use the raw code
    const type = mapGOCAOrderType(orderCode);

    orders.push({ type, params });
    offset += paramLength;
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Barcode Descriptor parser
// ---------------------------------------------------------------------------

/**
 * Parses a BDD (Bar Code Data Descriptor, D3AEEB) structured field data
 * payload to extract barcode parameters.
 *
 * Typical BDD data layout:
 *   Byte 0:      Barcode type
 *   Byte 1:      Module width (in L-units / scale factor)
 *   Bytes 2-3:   Element height (bar height) in L-units (big-endian 16-bit)
 *   Byte 4:      Wide-to-narrow ratio (for Code 39 etc.)
 *   Byte 5:      Flags (bit 0 = human readable indicator)
 *   Byte 6:      Orientation (0x00=0, 0x5A=90, 0xB4=180, 0x10E=270)
 *   Byte 7:      Color (index)
 */
export function parseBarcodeDescriptor(data: Uint8Array): Partial<BCOCAObject> {
  const result: Partial<BCOCAObject> = {};

  if (data.length < 1) return result;

  // Barcode type
  result.barcodeType = mapBarcodeType(data[0]);

  if (data.length >= 2) {
    // Module width — sometimes stored as a multiplier; we convert to L-units.
    // Many generators store the value directly in L-units.
    result.moduleWidth = data[1] > 0 ? data[1] : 10;
  }

  if (data.length >= 4) {
    // Bar height in L-units
    result.barHeight = readU16(data, 2);
    if (result.barHeight === 0) result.barHeight = 720; // default 0.5"
  }

  if (data.length >= 6) {
    // Flags byte
    const flags = data[5];
    result.humanReadable = (flags & 0x01) !== 0;
  } else {
    result.humanReadable = true;
  }

  if (data.length >= 7) {
    // Orientation
    const orientByte = data[6];
    if (orientByte === 0x5A) {
      result.orientation = 90;
    } else if (orientByte === 0xB4) {
      result.orientation = 180;
    } else if (orientByte === 0x0E || orientByte === 0x10) {
      result.orientation = 270;
    } else {
      result.orientation = 0;
    }
  }

  if (data.length >= 8) {
    // Color index — map to AFPColor
    const colorIdx = data[7];
    result.color = mapIndexedColor(colorIdx);
  } else {
    result.color = { r: 0, g: 0, b: 0, a: 255 };
  }

  result.x = 0;
  result.y = 0;

  return result;
}

// ---------------------------------------------------------------------------
// Object Area Position parser
// ---------------------------------------------------------------------------

/**
 * Parses an OBP (Object Area Position, D3AC6B) structured field to extract
 * the position (and optionally size) of the next object.
 *
 * The OBP data contains positional triplets. The most common layout:
 *   Bytes 0-2:   Object area origin — X (3-byte big-endian L-units)
 *   Bytes 3-5:   Object area origin — Y (3-byte big-endian L-units)
 *   Byte 6:      Orientation rotation (if present)
 *
 * Some implementations use the RG (Repeating Group) triplet format where
 * positions appear at fixed offsets.
 */
function parseObjectAreaPosition(data: Uint8Array, state: ParseState): void {
  if (data.length < 6) return;

  // Read X and Y as 3-byte big-endian values
  state.objectX = readU24(data, 0);
  state.objectY = readU24(data, 3);

  // If additional data is present, try to extract the object size
  if (data.length >= 12) {
    state.objectWidth = readU24(data, 6);
    state.objectHeight = readU24(data, 9);
  }

  // Some OBP structures store the data in a different format using
  // repeating groups at byte 1 (skipping a flags byte). Detect this
  // by checking whether the parsed values look unreasonable.
  if (state.objectX > 100000 && data.length >= 7) {
    // Try alternative layout: byte 0 = flags, then 3-byte X, 3-byte Y
    const altX = readU24(data, 1);
    const altY = readU24(data, 4);
    if (altX < 100000 && altY < 100000) {
      state.objectX = altX;
      state.objectY = altY;
      if (data.length >= 13) {
        state.objectWidth = readU24(data, 7);
        state.objectHeight = readU24(data, 10);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Triplet extractors
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a page sequence number from BPG triplet data.
 * Returns 0 if no page number can be extracted.
 */
function extractPageNumberFromTriplets(
  data: Uint8Array,
  startOffset: number,
): number {
  let offset = startOffset;
  while (offset + 2 <= data.length) {
    const tripletLen = data[offset];
    if (tripletLen < 2 || offset + tripletLen > data.length) break;

    const tripletId = data[offset + 1];

    // Triplet 0x62 — Page Sequence Number
    if (tripletId === 0x62 && tripletLen >= 4) {
      return readU16(data, offset + 2);
    }

    offset += tripletLen;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapCompressionId(id: number): IOCACompression {
  switch (id) {
    case 0x00: return IOCACompression.None;
    case 0x03: return IOCACompression.JPEG;
    case 0x07: return IOCACompression.CCITTG3;
    case 0x08: return IOCACompression.CCITTG4;
    case 0x0C: return IOCACompression.IBMMMR;
    default: return IOCACompression.None;
  }
}

function mapColorModel(id: number): IOCAColorModel {
  switch (id) {
    case 0x01: return IOCAColorModel.BiLevel;
    case 0x04: return IOCAColorModel.Grayscale;
    case 0x05: return IOCAColorModel.RGB;
    case 0x06: return IOCAColorModel.CMYK;
    case 0x12: return IOCAColorModel.YCbCr;
    default: return IOCAColorModel.BiLevel;
  }
}

function mapBarcodeType(id: number): BarcodeType {
  switch (id) {
    case 0x01: return BarcodeType.Code39;
    case 0x03: return BarcodeType.Interleaved2of5;
    case 0x05: return BarcodeType.Code128;
    case 0x09: return BarcodeType.EAN13;
    case 0x0A: return BarcodeType.UPC_A;
    case 0x1E: return BarcodeType.QR;
    case 0x1F: return BarcodeType.DataMatrix;
    case 0x22: return BarcodeType.PDF417;
    default: return BarcodeType.Code128;
  }
}

function mapGOCAOrderType(code: number): GOCADrawingOrderType {
  // Check if the code is a known enum value
  const known: GOCADrawingOrderType[] = [
    GOCADrawingOrderType.GBOX,
    GOCADrawingOrderType.GLINE,
    GOCADrawingOrderType.GCLINE,
    GOCADrawingOrderType.GARC,
    GOCADrawingOrderType.GFLT,
    GOCADrawingOrderType.GCBEZ,
    GOCADrawingOrderType.GSCOL,
    GOCADrawingOrderType.GSLW,
    GOCADrawingOrderType.GSLT,
    GOCADrawingOrderType.GSFLW,
    GOCADrawingOrderType.GSMK,
    GOCADrawingOrderType.GCBOX,
    GOCADrawingOrderType.GMRK,
  ];

  for (const k of known) {
    if (k === code) return k;
  }

  // Return as-is — the renderer will skip unknown order types
  return code as GOCADrawingOrderType;
}

function mapIndexedColor(idx: number): { r: number; g: number; b: number; a: number } {
  switch (idx) {
    case 0x00: return { r: 0,   g: 0,   b: 0,   a: 255 }; // black (default)
    case 0x01: return { r: 0,   g: 0,   b: 255, a: 255 }; // blue
    case 0x02: return { r: 255, g: 0,   b: 0,   a: 255 }; // red
    case 0x03: return { r: 255, g: 0,   b: 255, a: 255 }; // magenta
    case 0x04: return { r: 0,   g: 255, b: 0,   a: 255 }; // green
    case 0x05: return { r: 0,   g: 255, b: 255, a: 255 }; // cyan
    case 0x06: return { r: 255, g: 255, b: 0,   a: 255 }; // yellow
    case 0x07: return { r: 255, g: 255, b: 255, a: 255 }; // white
    case 0x08: return { r: 0,   g: 0,   b: 0,   a: 255 }; // black
    case 0x10: return { r: 139, g: 69,  b: 19,  a: 255 }; // brown
    default:   return { r: 0,   g: 0,   b: 0,   a: 255 };
  }
}

// ---------------------------------------------------------------------------
// GOCA bounding-box computation
// ---------------------------------------------------------------------------

/**
 * Computes a rough bounding box for a set of GOCA drawing orders by
 * inspecting the coordinate parameters.
 */
function computeGOCABounds(
  orders: GOCADrawingOrder[],
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let hasCoords = false;

  for (const order of orders) {
    const p = order.params;

    switch (order.type) {
      case GOCADrawingOrderType.GLINE: {
        // 4 coordinates: x1, y1, x2, y2 (each 2 bytes = 8 params)
        if (p.length >= 8) {
          const coords = [
            readParamS16(p, 0), readParamS16(p, 2),
            readParamS16(p, 4), readParamS16(p, 6),
          ];
          updateBounds(coords[0], coords[1]);
          updateBounds(coords[2], coords[3]);
        }
        break;
      }

      case GOCADrawingOrderType.GCLINE: {
        if (p.length >= 4) {
          updateBounds(readParamS16(p, 0), readParamS16(p, 2));
        }
        break;
      }

      case GOCADrawingOrderType.GBOX:
      case GOCADrawingOrderType.GCBOX: {
        if (p.length >= 10) {
          const x1 = readParamS16(p, 2);
          const y1 = readParamS16(p, 4);
          const x2 = readParamS16(p, 6);
          const y2 = readParamS16(p, 8);
          // GBOX uses corner coordinates, not position+size
          updateBounds(x1, y1);
          updateBounds(x2, y2);
        }
        break;
      }

      case GOCADrawingOrderType.GARC: {
        if (p.length >= 6) {
          const cx = readParamS16(p, 0);
          const cy = readParamS16(p, 2);
          const r = Math.abs(readParamS16(p, 4));
          updateBounds(cx - r, cy - r);
          updateBounds(cx + r, cy + r);
        }
        break;
      }

      case GOCADrawingOrderType.GFLT:
      case GOCADrawingOrderType.GCBEZ: {
        for (let i = 0; i + 3 < p.length; i += 4) {
          updateBounds(readParamS16(p, i), readParamS16(p, i + 2));
        }
        break;
      }

      case GOCADrawingOrderType.GMRK: {
        if (p.length >= 4) {
          updateBounds(readParamS16(p, 0), readParamS16(p, 2));
        }
        break;
      }

      default:
        break;
    }
  }

  if (!hasCoords) return undefined;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  function updateBounds(x: number, y: number): void {
    hasCoords = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
}

/** Read a signed 16-bit value from a params number array. */
function readParamS16(params: number[], index: number): number {
  if (index + 1 >= params.length) return 0;
  const val = (params[index] << 8) | params[index + 1];
  return val > 0x7FFF ? val - 0x10000 : val;
}
