/**
 * AFP Viewer — Core type definitions for all AFP sub-architectures.
 *
 * Types cover MO:DCA structured fields plus PTOCA, IOCA, GOCA, BCOCA, and FOCA
 * object models used throughout the parsing and rendering pipeline.
 */

// ---------------------------------------------------------------------------
// Common / shared
// ---------------------------------------------------------------------------

/** RGBA colour expressed as 0-255 per channel. */
export interface AFPColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Text orientation in 90-degree increments. */
export type Orientation = 0 | 90 | 180 | 270;

/** Coordinate pair in L-units (1/1440 inch unless otherwise specified). */
export interface LUnitPoint {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Structured-field level
// ---------------------------------------------------------------------------

export interface StructuredField {
  typeId: number;        // 3-byte type code packed into a 24-bit number
  length: number;        // total field length (excluding leading 0x5A)
  flags: number;
  sequence: number;
  data: Uint8Array;
}

export interface PageIndex {
  pageNumber: number;
  byteOffset: number;    // absolute offset of BPG in file
  byteLength: number;    // bytes from BPG to EPG inclusive
  objectCount?: number;
}

// ---------------------------------------------------------------------------
// PTOCA (Presentation Text)
// ---------------------------------------------------------------------------

/** A single run of text sharing the same styling. */
export interface TextRun {
  x: number;             // inline position in L-units
  y: number;             // baseline position in L-units
  text: string;          // decoded Unicode text
  fontId: number;        // coded font local ID
  color: AFPColor;
  orientation: Orientation;
  fontSize: number;      // approximate size in points (derived from font metrics)
  bold?: boolean;
  underline?: boolean;
}

/** Result of parsing a PTX structured field through the PTOCA parser. */
export interface PTOCATextObject {
  runs: TextRun[];
  /** Bounding rectangle in L-units (computed from min/max run positions). */
  bounds: { x: number; y: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// IOCA (Image)
// ---------------------------------------------------------------------------

export enum IOCACompression {
  None          = 0x00,
  JPEG          = 0x03,
  CCITTG3       = 0x07,
  CCITTG4       = 0x08,
  IBMMMR        = 0x0C,
}

export enum IOCAColorModel {
  BiLevel       = 0x01,
  Grayscale     = 0x04,
  RGB           = 0x05,
  CMYK          = 0x06,
  YCbCr         = 0x12,
}

export interface IOCAImageObject {
  width: number;
  height: number;
  xResolution: number;   // dots per 10 inches
  yResolution: number;
  bitDepth: number;       // bits per pixel (1, 4, 8, 24 …)
  compression: IOCACompression;
  colorModel: IOCAColorModel;
  data: Uint8Array;       // raw (possibly compressed) image data
}

// ---------------------------------------------------------------------------
// GOCA (Graphics)
// ---------------------------------------------------------------------------

export enum GOCADrawingOrderType {
  GBOX   = 0xC0,
  GLINE  = 0xC1,
  GCLINE = 0x81,
  GARC   = 0xC6,
  GFLT   = 0xC5,
  GCBEZ  = 0x85,
  GSCOL  = 0x08,
  GSLW   = 0x19,
  GSLT   = 0x18,
  GSFLW  = 0x11,
  GSMK   = 0x29,
  GCBOX  = 0x80,
  GMRK   = 0xC2,
}

export interface GOCADrawingOrder {
  type: GOCADrawingOrderType;
  params: number[];      // raw parameter bytes for the specific order
}

export interface GOCAObject {
  orders: GOCADrawingOrder[];
  data: Uint8Array;       // original raw bytes
  bounds?: { x: number; y: number; width: number; height: number };
  /** Ratio to convert segment coordinates to page L-units (e.g., 4.8 for 300dpi segment on 1440 page). */
  coordinateScale?: number;
  /** If true, X coordinates should be mirrored (overlay GOCA uses right-to-left X axis). */
  flipX?: boolean;
}

// ---------------------------------------------------------------------------
// BCOCA (Bar Code)
// ---------------------------------------------------------------------------

export enum BarcodeType {
  Code39      = 0x01,
  Code128     = 0x05,
  EAN13       = 0x09,
  UPC_A       = 0x0A,
  Interleaved2of5 = 0x03,
  QR          = 0x1E,
  DataMatrix  = 0x1F,
  PDF417      = 0x22,
}

export interface BCOCAObject {
  barcodeType: BarcodeType;
  data: string;            // decoded barcode payload
  rawData: Uint8Array;
  moduleWidth: number;     // bar module width in L-units
  barHeight: number;       // bar height in L-units
  color: AFPColor;
  humanReadable: boolean;  // whether to print text label
  orientation: Orientation;
  x: number;               // position in L-units
  y: number;
}

// ---------------------------------------------------------------------------
// FOCA (Font)
// ---------------------------------------------------------------------------

export interface FOCAFontMetrics {
  fontId: number;
  characterSet: string;
  codePage: string;
  avgCharWidth: number;
  maxCharWidth: number;
  ascender: number;
  descender: number;
  spaceWidth: number;
}

/**
 * One row from a Map Coded Font (MCF, D3AB8A) repeating group.
 *
 * The MCF maps a font local ID (used by PTOCA's SCFL control sequence) to
 * a coded font name and a character set / code page name. The character set
 * name suffix encodes the weight (e.g. C0FL.. = regular Latin, C0FM.. = bold).
 */
export interface FontMapping {
  /** Font local ID — the byte set by SCFL (PTOCA 0xF1). */
  localId: number;
  /** Coded Font Name from FQN triplet 0x85 (e.g. "T10D1144"). */
  codedFontName: string | null;
  /** Character Set Name from FQN triplet 0x86 (e.g. "C0FL20A0"). */
  characterSetName: string | null;
  /** Derived weight: true if the character set name indicates bold. */
  bold: boolean;
}

/** A snapshot of an MCF table — keyed by font local ID. */
export type FontMappingTable = ReadonlyMap<number, FontMapping>;

// ---------------------------------------------------------------------------
// Page render tree
// ---------------------------------------------------------------------------

export type PageObjectKind = 'text' | 'image' | 'graphics' | 'barcode';

export interface PageObject {
  kind: PageObjectKind;
  /** Position within the page in L-units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** AFP resource name this object came from (e.g., page-segment or overlay name). */
  resourceName?: string;
  /** Sub-architecture payload. Exactly one of these is populated. */
  text?: PTOCATextObject;
  image?: IOCAImageObject;
  graphics?: GOCAObject;
  barcode?: BCOCAObject;
}

export interface PageRenderTree {
  pageNumber: number;
  /** Page dimensions in L-units. */
  width: number;
  height: number;
  /** Resolution in L-units per inch (default 1440). */
  resolution: number;
  objects: PageObject[];
}

// ---------------------------------------------------------------------------
// Extended parser types (used by parser.ts)
// ---------------------------------------------------------------------------

/** Extended structured field representation emitted by the binary parser. */
export interface AFPStructuredField {
  typeId: string;          // hex string like "D3A8AD"
  typeName: string;        // human-readable name
  offset: number;          // absolute byte offset of 0x5A in the buffer
  length: number;          // LENGTH field value (excludes 0x5A)
  flags: number;
  sequenceNumber: number;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Index and search
// ---------------------------------------------------------------------------

/** Entry in the page-offset index built during Pass 1 (index scan). */
export interface PageIndexEntry {
  pageNumber: number;
  /** Absolute byte offset of the BPG structured field in the file. */
  byteOffset: number;
  /** Byte length from BPG to EPG inclusive. */
  byteLength: number;
  /** Number of objects detected on this page (optional, populated later). */
  objectCount?: number;
  /** Extracted plain text from this page (populated on demand for search). */
  textContent?: string;
  /** Which named group (document) index this page belongs to. */
  documentIndex?: number;
  /** Name from the BNG structured field. */
  documentName?: string | null;
  /** Resource names referenced on this page. */
  resourceRefs?: string[];
  /** Whether this page contains PTOCA text objects. */
  hasText?: boolean;
  /** Whether this page contains IOCA image objects. */
  hasImages?: boolean;
}

/** A single search hit. */
export interface SearchResult {
  pageNumber: number;
  /** Excerpt of text surrounding the match. */
  snippet: string;
  /** Character offset of match within the page text. */
  matchOffset: number;
  /** Length of the matched text. */
  matchLength: number;
}

/** Alias kept for compatibility with the original PageIndex interface. */
export type { PageIndex as PageIndexLegacy };

// ---------------------------------------------------------------------------
// Render-related types
// ---------------------------------------------------------------------------

/** Union type for render-target surfaces. */
export type RenderSurface = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** A fully decoded render object ready for compositor dispatch. */
export interface RenderObject {
  kind: PageObjectKind;
  /** Position in pixels (already converted from L-units). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The original page object this was derived from. */
  source: PageObject;
}
