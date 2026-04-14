/**
 * AFP constant definitions — magic bytes and structured field type codes.
 */

/** The magic byte that precedes every AFP structured field. */
export const MAGIC_BYTE = 0x5a;

/** Default AFP resolution in L-units per inch. */
export const DEFAULT_RESOLUTION = 1440;

/**
 * Map from 6-character hex type-ID to human-readable name.
 * Only the most commonly encountered field types are listed here;
 * the parser falls back to its own built-in table for unlisted codes.
 */
export const SF_TYPES: Record<string, string> = {
  // Document level
  'D3A8A8': 'Begin Document (BDT)',
  'D3A9A8': 'End Document (EDT)',

  // Page level
  'D3A8AD': 'Begin Page (BPG)',
  'D3A9AD': 'End Page (EPG)',

  // Active environment group
  'D3A8C9': 'Begin Active Environment Group (BAG)',
  'D3A9C9': 'End Active Environment Group (EAG)',

  // Presentation text
  'D3A87B': 'Begin Presentation Text (BPT)',
  'D3A97B': 'End Presentation Text (EPT)',
  'D3EEEE': 'Presentation Text Descriptor (PTD)',
  'D3EE9B': 'Presentation Text Data (PTX)',

  // Image
  'D3A8C5': 'Begin Image (BIM)',
  'D3A9C5': 'End Image (EIM)',
  'D3ACCE': 'Image Data Descriptor (IDD)',
  'D3EE7B': 'Image Data Element (IDE)',

  // Graphics
  'D3A8C3': 'Begin Graphics (BGR)',
  'D3A9C3': 'End Graphics (EGR)',
  'D3EECC': 'Graphics Data (GAD)',

  // Bar code
  'D3A8EB': 'Begin Bar Code (BBC)',
  'D3A9EB': 'End Bar Code (EBC)',
  'D3AEEB': 'Bar Code Data (BDD)',

  // Object area
  'D3A6C3': 'Object Area Descriptor (OAD)',
  'D3AC6B': 'Object Area Position (OBP)',

  // Page descriptor
  'D3A6AF': 'Page Descriptor (PGD)',

  // Resource
  'D3ABAF': 'Begin Resource (BRS)',
  'D3A9AF': 'End Resource (ERS)',

  // Named page group
  'D3A8CA': 'Begin Named Group (BNG)',
  'D3A9CA': 'End Named Group (ENG)',

  // Font
  'D3A8A7': 'Begin Font (BFN)',
  'D3A6EE': 'Font Control (FNC)',

  // Map
  'D3ABCC': 'Map Coded Font (MCF)',
  'D3ABCE': 'Map Image Object (MIO)',
};

/**
 * Type IDs that mark the beginning of a page (BPG).
 */
export const BPG_TYPE_ID = 'D3A8AD';

/**
 * Type IDs that mark the end of a page (EPG).
 */
export const EPG_TYPE_ID = 'D3A9AD';

/**
 * Type IDs for sub-architecture begin markers.
 */
export const SUB_ARCH_BEGIN = {
  TEXT: 'D3A87B',      // BPT
  IMAGE: 'D3A8C5',     // BIM
  GRAPHICS: 'D3A8C3',  // BGR
  BARCODE: 'D3A8EB',   // BBC
} as const;

/**
 * Type IDs for sub-architecture end markers.
 */
export const SUB_ARCH_END = {
  TEXT: 'D3A97B',      // EPT
  IMAGE: 'D3A9C5',     // EIM
  GRAPHICS: 'D3A9C3',  // EGR
  BARCODE: 'D3A9EB',   // EBC
} as const;
