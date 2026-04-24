'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  FileText,
  Image,
  Type,
  BarChart3,
  PenTool,
  Box,
  Settings2,
  Database,
  Layers,
  File,
  Search,
} from 'lucide-react';

interface TreeNode {
  id: string;
  typeId: string;
  abbrev: string;
  fullName: string;
  offset: number;
  length: number;
  dataPreview: string;
  children: TreeNode[];
  depth: number;
  icon: string;
  /** Pre-computed lowercase search text for fast matching. */
  _searchText?: string;
}

// [abbreviation, full name, icon]
const TYPE_INFO: Record<string, [string, string, string]> = {
  'D3A090': ['TLE', 'Tag Logical Element', 'layers'],
  'D3A8A5': ['BPF', 'Begin Print File', 'file'],
  'D3A9A5': ['EPF', 'End Print File', 'file'],
  'D3A8A8': ['BDT', 'Begin Document', 'layers'],
  'D3A9A8': ['EDT', 'End Document', 'layers'],
  'D3A8AD': ['BPG', 'Begin Page', 'file'],
  'D3A9AD': ['EPG', 'End Page', 'file'],
  'D3A8AF': ['BRS', 'Begin Resource', 'box'],
  'D3A9AF': ['ERS', 'End Resource', 'box'],
  'D3A8C9': ['BAG', 'Begin Active Env Group', 'layers'],
  'D3A9C9': ['EAG', 'End Active Env Group', 'layers'],
  'D3A8C6': ['BOG', 'Begin Object Env Group', 'layers'],
  'D3A9C6': ['EOG', 'End Object Env Group', 'layers'],
  'D3A8CE': ['BOC', 'Begin Object Container', 'box'],
  'D3A9CE': ['EOC', 'End Object Container', 'box'],
  'D3A87B': ['BPT', 'Begin Presentation Text', 'type'],
  'D3A97B': ['EPT', 'End Presentation Text', 'type'],
  'D3A89B': ['BPT', 'Begin Presentation Text', 'type'],
  'D3A99B': ['EPT', 'End Presentation Text', 'type'],
  'D3EE9B': ['PTX', 'Presentation Text Data', 'type'],
  'D3EE6B': ['PTX', 'Presentation Text Data', 'type'],
  'D3EEEE': ['NOP', 'No Operation', 'file'],
  'D3A8C5': ['BIM', 'Begin Image', 'image'],
  'D3A9C5': ['EIM', 'End Image', 'image'],
  'D3A892': ['BII', 'Begin IM Image', 'image'],
  'D3A992': ['EII', 'End IM Image', 'image'],
  'D3EE92': ['IID', 'IM Image Data', 'image'],
  'D3ACCE': ['IDD', 'Image Data Descriptor', 'image'],
  'D3EE7B': ['IDE', 'Image Data', 'image'],
  'D3A8C3': ['BGR', 'Begin Graphics', 'pen'],
  'D3A9C3': ['EGR', 'End Graphics', 'pen'],
  'D3EECC': ['GAD', 'Graphics Data', 'pen'],
  'D3A8EB': ['BBC', 'Begin Bar Code', 'barcode'],
  'D3A9EB': ['EBC', 'End Bar Code', 'barcode'],
  'D3AEEB': ['BDD', 'Bar Code Data Descriptor', 'barcode'],
  'D3A6AF': ['PGD', 'Page Descriptor', 'file'],
  'D3ABC3': ['MCF', 'Map Coded Font', 'type'],
  'D3ABCE': ['MIO', 'Map Image Object', 'image'],
  'D3AC6B': ['OBP', 'Object Area Position', 'box'],
  'D3A6C3': ['OAD', 'Object Area Descriptor', 'box'],
  'D3AFC3': ['IOC', 'Include Object', 'box'],
  'D3B19B': ['PTP', 'Pres Text Position', 'type'],
  'D3A28A': ['LND', 'Line Descriptor', 'type'],
  'D3A688': ['MDD', 'Medium Descriptor', 'file'],
  'D3A68A': ['FDD', 'Form Descriptor', 'file'],
  'D3ABCA': ['BNG', 'Begin Named Group', 'layers'],
  'D3A9CA': ['ENG', 'End Named Group', 'layers'],
  'D3A8A7': ['BAG', 'Begin Object Area', 'box'],
  'D3A9A7': ['EAG', 'End Object Area', 'box'],
  'D3A6EE': ['FNC', 'Font Control', 'type'],
  'D3A87E': ['BFG', 'Begin Font Resource Group', 'type'],
  // NOP - No Operation (often contains metadata text)
  'D3AFEE': ['NOP', 'No Operation', 'file'],
  'D3A8EE': ['NOP', 'No Operation', 'file'],
  // IMM - Invoke Medium Map
  'D3ABCC': ['MCC', 'Medium Copy Count', 'file'],
  'D3AB88': ['IMM', 'Invoke Medium Map', 'file'],
  'D3ABD8': ['MPO', 'Map Page Overlay', 'box'],
  'D3AFD8': ['IPO', 'Include Page Overlay', 'box'],
  'D3AF5F': ['IPS', 'Include Page Segment', 'box'],
  'D3B15F': ['MPS', 'Map Page Segment', 'box'],
  'D3B18A': ['MMC', 'Medium Modification Control', 'file'],
  'D3EEBB': ['OCD', 'Object Container Data', 'box'],
  'D3A79B': ['PEC', 'Presentation Environment Control', 'file'],
  'D3A69B': ['PFC', 'Presentation Fidelity Control', 'file'],
  'D3A8BB': ['BDI', 'Begin Document Index', 'layers'],
  'D3A9BB': ['EDI', 'End Document Index', 'layers'],
  'D3A8C7': ['BDG', 'Begin Document Environment Group', 'layers'],
  'D3A9C7': ['EDG', 'End Document Environment Group', 'layers'],
  'D3A66B': ['OAD', 'Object Area Descriptor', 'box'],
  'D3A6BB': ['IDD2', 'Index Element Descriptor', 'file'],
  // Form Map / Medium Map
  'D3A888': ['BMM', 'Begin Medium Map', 'file'],
  'D3A988': ['EMM', 'End Medium Map', 'file'],
  'D3A88A': ['BFM', 'Begin Form Map', 'file'],
  'D3A98A': ['EFM', 'End Form Map', 'file'],
  // Character Sets / Code Pages / Fonts
  'D3A885': ['BCF', 'Begin Coded Font', 'type'],
  'D3A985': ['ECF', 'End Coded Font', 'type'],
  'D3A887': ['BCS', 'Begin Character Set', 'type'],
  'D3A987': ['ECS', 'End Character Set', 'type'],
  'D3A889': ['BCP', 'Begin Code Page', 'type'],
  'D3A989': ['ECP', 'End Code Page', 'type'],
  'D3A8A6': ['BFN', 'Begin Font', 'type'],
  'D3A9A6': ['EFN', 'End Font', 'type'],
  'D3AB89': ['MCP', 'Map Code Page', 'type'],
  // Page Segments / Overlays
  'D3A8C4': ['BPS', 'Begin Page Segment', 'box'],
  'D3A9C4': ['BPS', 'End Page Segment', 'box'],
  'D3A8DF': ['BOV', 'Begin Overlay', 'box'],
  'D3A9DF': ['EOV', 'End Overlay', 'box'],
  'D3ABDF': ['MOV', 'Map Overlay', 'box'],
  // Presentation Environment
  'D3AB5F': ['MFC', 'Map Form Control', 'file'],
  'D3A65F': ['FND', 'Font Descriptor', 'type'],
  'D3A787': ['CPC', 'Code Page Control', 'type'],
  'D3A689': ['CPD', 'Code Page Descriptor', 'type'],
  'D3A687': ['CSD', 'Character Set Descriptor', 'type'],
  'D3A686': ['CFD', 'Coded Font Descriptor', 'type'],
  'D3EE89': ['CPI', 'Code Page Index', 'type'],
  'D3A289': ['CPM', 'Code Page Map', 'type'],
  // Font Patterns
  'D3EE87': ['FNP', 'Font Pattern', 'type'],
  'D3AE87': ['FNM', 'Font Pattern Map', 'type'],
  // Page Segment / Object Container resources
  'D3A85F': ['BPS', 'Begin Page Segment', 'box'],
  'D3A95F': ['EPS', 'End Page Segment', 'box'],
  'D3A8FB': ['BII', 'Begin Image (II)', 'image'],
  'D3A9FB': ['EII', 'End Image (II)', 'image'],
  'D3EEFB': ['IRD', 'Image Raster Data', 'image'],
  'D3ABFB': ['MII', 'Map Image (II)', 'image'],
  'D3A6FB': ['IID', 'Image Input Descriptor', 'image'],
  // Code Page internals
  'D3A789': ['CPC', 'Code Page Control', 'type'],
  'D3AE89': ['CPM', 'Code Page Map', 'type'],
  'D3AC89': ['CPI', 'Code Page Index', 'type'],
  'D38C89': ['CPF', 'Code Page Font', 'type'],
  // Character Set internals
  'D38C87': ['CSF', 'Character Set Font', 'type'],
  // Image Object
  'D3A8CD': ['BII', 'Begin IM Image Object', 'image'],
  'D3A9CD': ['EII', 'End IM Image Object', 'image'],
  // Object Container
  'D3A8CC': ['BOC', 'Begin Object Container', 'box'],
  'D3A9CC': ['EOC', 'End Object Container', 'box'],
  // Medium Map / Form Definition
  'D3A6C5': ['MDD', 'Medium Descriptor', 'file'],
  'D3B1AF': ['PPO', 'Preprocess Object', 'box'],
  'D3A288': ['MDR', 'Medium Data Record', 'file'],
  'D3A788': ['MMC', 'Medium Modification Control', 'file'],
  'D3AB8A': ['MMC', 'Map Medium Copy Count', 'file'],
};

function getAbbrev(typeId: string): string {
  return TYPE_INFO[typeId]?.[0] ?? typeId;
}

function getFullName(typeId: string): string {
  return TYPE_INFO[typeId]?.[1] ?? `Unknown (${typeId})`;
}

function getIconType(typeId: string): string {
  return TYPE_INFO[typeId]?.[2] ?? 'file';
}

function isBeginType(typeId: string): boolean {
  const b2 = typeId.substring(2, 4);
  return b2 === 'A8' || typeId === 'D3ABCA';
}

function isEndType(typeId: string): boolean {
  const b2 = typeId.substring(2, 4);
  return b2 === 'A9';
}

/** Simple EBCDIC single-byte decode (CP500 International with German support). */
function ebcdicByte(b: number): string {
  if (b >= 0xC1 && b <= 0xC9) return String.fromCharCode(65 + b - 0xC1); // A-I
  if (b >= 0xD1 && b <= 0xD9) return String.fromCharCode(74 + b - 0xD1); // J-R
  if (b >= 0xE2 && b <= 0xE9) return String.fromCharCode(83 + b - 0xE2); // S-Z
  if (b >= 0x81 && b <= 0x89) return String.fromCharCode(97 + b - 0x81); // a-i
  if (b >= 0x91 && b <= 0x99) return String.fromCharCode(106 + b - 0x91); // j-r
  if (b >= 0xA2 && b <= 0xA9) return String.fromCharCode(115 + b - 0xA2); // s-z
  if (b >= 0xF0 && b <= 0xF9) return String.fromCharCode(48 + b - 0xF0); // 0-9
  if (b === 0x40) return ' ';
  if (b === 0x4B) return '.';
  if (b === 0x6B) return ',';
  if (b === 0x7D) return "'";
  if (b === 0x60) return '-';
  if (b === 0x61) return '/';
  if (b === 0x50) return '&';
  if (b === 0x6D) return '_';
  if (b === 0x7A) return ':';
  if (b === 0x7C) return '@';
  if (b === 0x5C) return '*';
  if (b === 0x4D) return '(';
  if (b === 0x5D) return ')';
  if (b === 0x7E) return '=';
  // CP500 German/European characters
  if (b === 0xC0) return 'ä';
  if (b === 0xD0) return 'ü';
  if (b === 0xE0) return 'Ö';
  if (b === 0xA1) return 'ß';
  if (b === 0xEC) return 'Ä';
  if (b === 0xDC) return 'Ü';
  if (b === 0xCC) return 'ö';
  if (b === 0x59) return 'ß';
  if (b === 0x43) return 'ä';
  return '';
}

/** Decode EBCDIC bytes to string, skipping unmappable chars. */
function ebcdicStr(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < data.length; i++) {
    s += ebcdicByte(data[i]);
  }
  return s.trim();
}

/**
 * Extract a human-readable preview from structured field data.
 * For TLE (D3A090): parses triplets to show key = value.
 * For others: shows EBCDIC or ASCII decoded content.
 */
function getDataPreview(data: Uint8Array, typeId: string): string {
  // TLE: parse triplets for key=value
  if (typeId === 'D3A090') {
    return parseTLETriplets(data);
  }

  // For general fields: try EBCDIC decode, fall back to ASCII
  const ebcdic = ebcdicStr(data, 0, Math.min(data.length, 50));
  if (ebcdic.length > 3) return ebcdic;

  // ASCII fallback
  const chars: string[] = [];
  for (let i = 0; i < Math.min(data.length, 50); i++) {
    const b = data[i];
    if (b >= 0x20 && b < 0x7F) chars.push(String.fromCharCode(b));
    else if (b !== 0x00) chars.push('.');
  }
  return chars.join('');
}

/** Parse TLE triplets to extract key = value pairs. */
function parseTLETriplets(data: Uint8Array): string {
  let key = '';
  let value = '';
  let j = 0;
  while (j < data.length) {
    if (j + 2 > data.length) break;
    const tlen = data[j];
    if (tlen < 2 || j + tlen > data.length) break;
    const tid = data[j + 1];

    if (tid === 0x02 && tlen > 4) {
      // Fully Qualified Name (key) — skip 2-byte type/format prefix
      key = ebcdicStr(data, j + 4, j + tlen);
    } else if (tid === 0x36 && tlen > 4) {
      // Attribute Value — skip 2-byte format prefix
      value = ebcdicStr(data, j + 4, j + tlen);
    }
    j += tlen;
  }
  if (key) return value ? `${key} = ${value}` : key;
  return '';
}

function IconForType({ type }: { type: string }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  switch (type) {
    case 'database': return <Database className={`${cls} text-indigo-500`} />;
    case 'type': return <Type className={`${cls} text-blue-500`} />;
    case 'image': return <Image className={`${cls} text-green-500`} />;
    case 'pen': return <PenTool className={`${cls} text-purple-500`} />;
    case 'barcode': return <BarChart3 className={`${cls} text-orange-500`} />;
    case 'box': return <Box className={`${cls} text-yellow-600`} />;
    case 'layers': return <Layers className={`${cls} text-cyan-500`} />;
    default: return <File className={`${cls} text-gray-400`} />;
  }
}

interface ParseState {
  offset: number;
  id: number;
  stack: TreeNode[];
  done: boolean;
  totalParsed: number;
}

const INITIAL_CHUNK = 50000; // First chunk — instant display
const BG_CHUNK = 20000;      // Background chunks — progressive loading

/**
 * Parse AFP structured fields into tree nodes, up to `maxItems` at a time.
 * Supports incremental parsing: pass the returned state back to continue.
 * `rootNodes` is mutated in place — new top-level nodes are pushed to it.
 * `baseDepth` offsets the depth (use 1 when wrapping in a root node).
 */
function buildTreeChunk(
  buffer: ArrayBuffer,
  rootNodes: TreeNode[],
  state: ParseState | null,
  maxItems: number,
  baseDepth: number = 0,
): ParseState {
  const view = new DataView(buffer);
  let offset = state?.offset ?? 0;
  let id = state?.id ?? 0;
  const stack: TreeNode[] = state?.stack ? [...state.stack] : [];
  let totalParsed = state?.totalParsed ?? 0;
  let count = 0;

  while (offset < buffer.byteLength && count < maxItems) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 9 > buffer.byteLength) break;

    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) { offset++; continue; }

    const b1 = view.getUint8(offset + 3);
    const b2 = view.getUint8(offset + 4);
    const b3 = view.getUint8(offset + 5);
    const typeId = b1.toString(16).toUpperCase().padStart(2, '0') +
      b2.toString(16).toUpperCase().padStart(2, '0') +
      b3.toString(16).toUpperCase().padStart(2, '0');

    const dataLen = length - 8;
    const dataStart = offset + 9;
    const data = dataLen > 0 && dataStart + dataLen <= buffer.byteLength
      ? new Uint8Array(buffer, dataStart, Math.min(dataLen, 60))
      : new Uint8Array(0);

    const node: TreeNode = {
      id: `sf-${id++}`,
      typeId,
      abbrev: getAbbrev(typeId),
      fullName: getFullName(typeId),
      offset,
      length,
      dataPreview: getDataPreview(data, typeId),
      children: [],
      depth: stack.length + baseDepth,
      icon: getIconType(typeId),
    };

    if (isEndType(typeId)) {
      if (stack.length > 0) stack.pop();
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        rootNodes.push(node);
      }
    } else if (isBeginType(typeId)) {
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        rootNodes.push(node);
      }
      stack.push(node);
    } else {
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    const nextOffset = offset + 1 + length;
    if (nextOffset <= offset) break;
    offset = nextOffset;
    count++;
    totalParsed++;
  }

  return {
    offset,
    id,
    stack,
    done: offset >= buffer.byteLength,
    totalParsed,
  };
}

/** Collect all nodes in DFS order for search, pre-computing search text. */
function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(n: TreeNode) {
    // Pre-compute lowercase search text once, so search is a single .includes()
    n._searchText = `${n.abbrev}\0${n.fullName}\0${n.typeId}\0${n.dataPreview}`.toLowerCase();
    result.push(n);
    for (const c of n.children) walk(c);
  }
  for (const n of nodes) walk(n);
  return result;
}

/**
 * Build a child→parent map for O(1) ancestor lookups.
 * Returns a Map<childId, parentId>.
 */
function buildParentMap(nodes: TreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(n: TreeNode) {
    for (const c of n.children) {
      map.set(c.id, n.id);
      walk(c);
    }
  }
  for (const n of nodes) walk(n);
  return map;
}

/**
 * Get all ancestor IDs for a node using the pre-built parent map (O(depth)).
 */
function getAncestorIds(parentMap: Map<string, string>, targetId: string): Set<string> {
  const ids = new Set<string>();
  let current = parentMap.get(targetId);
  while (current) {
    ids.add(current);
    current = parentMap.get(current);
  }
  return ids;
}

/**
 * Export an AFP element (and its children) as a standalone AFP file.
 * Extracts the raw bytes from the element's offset through its end
 * (including all children's structured fields).
 */
function exportElementAsAfp(node: TreeNode, fileData: ArrayBuffer): void {
  // Calculate the byte range: from this node's offset to the end of its last child
  let endOffset = node.offset + 1 + node.length;

  // If the node has children, find the furthest child endpoint
  function findEnd(n: TreeNode): number {
    let maxEnd = n.offset + 1 + n.length;
    for (const child of n.children) {
      const childEnd = findEnd(child);
      if (childEnd > maxEnd) maxEnd = childEnd;
    }
    return maxEnd;
  }
  endOffset = findEnd(node);

  // Extract the bytes
  const start = node.offset;
  const data = new Uint8Array(fileData, start, Math.min(endOffset - start, fileData.byteLength - start));

  // Download as .afp file
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${node.abbrev}_${node.dataPreview.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}.afp`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Build a flat list of visible rows from the tree, respecting expanded state and showEndTags. */
function buildVisibleRows(
  roots: TreeNode[],
  expandedIds: Set<string>,
  showEndTags: boolean,
): TreeNode[] {
  const rows: TreeNode[] = [];
  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (!showEndTags && isEndType(node.typeId)) continue;
      rows.push(node);
      if (node.children.length > 0 && expandedIds.has(node.id)) {
        walk(node.children);
      }
    }
  }
  walk(roots);
  return rows;
}

function FlatTreeRow({
  node,
  isSelected,
  isMatch,
  isExpanded,
  hasChildren,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  isSelected: boolean;
  isMatch: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  onToggle: (id: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <button
      data-element-id={node.id}
      onClick={() => {
        onSelect(node);
        if (hasChildren) onToggle(node.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(node);
        const fileData = useAfpViewerStore.getState().fileData;
        if (!fileData) return;
        exportElementAsAfp(node, fileData);
      }}
      className={`flex w-full items-center gap-1 px-2 py-1 text-left text-xs transition-colors hover:bg-[hsl(var(--accent))] ${
        isSelected
          ? 'bg-[hsl(var(--primary))]/15 ring-1 ring-inset ring-[hsl(var(--primary))]'
          : isMatch
            ? 'bg-yellow-100 dark:bg-yellow-900/30'
            : ''
      }`}
      style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
    >
      {hasChildren ? (
        isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
        )
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <IconForType type={node.icon} />
      <span className={`shrink-0 font-medium ${isMatch ? 'text-yellow-700 dark:text-yellow-300' : ''}`}>
        {node.abbrev}
      </span>
      {node.dataPreview && (
        <span className="truncate text-[10px] text-[hsl(var(--muted-foreground))]">
          {node.dataPreview.length > 25 ? node.dataPreview.slice(0, 25) + '..' : node.dataPreview}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
        @{node.offset}
      </span>
    </button>
  );
}

export function ElementTree() {
  const { fileData } = useAfpViewer();
  const status = useAfpViewerStore((s) => s.status);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const currentPage = useAfpViewerStore((s) => s.currentPage);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [allFlat, setAllFlat] = useState<TreeNode[]>([]);
  const [parentMap, setParentMap] = useState<Map<string, string>>(new Map());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const selectedElementId = useAfpViewerStore((s) => s.selectedElementId);
  const setSelectedElementId = useAfpViewerStore((s) => s.setSelectedElementId);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedId = selectedElementId;

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIds, setMatchIds] = useState<Set<string>>(new Set());
  const [matchList, setMatchList] = useState<TreeNode[]>([]);
  const [matchIndex, setMatchIndex] = useState(-1);

  // Progressive loading state
  const parseStateRef = useRef<ParseState | null>(null);
  const childNodesRef = useRef<TreeNode[]>([]);
  const bgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [parseDone, setParseDone] = useState(true);
  const fileDataRef = useRef(fileData);
  fileDataRef.current = fileData;

  // Helper: create root wrapper and update all derived state
  const updateTreeState = useCallback((): { flat: TreeNode[]; pMap: Map<string, string> } => {
    const fd = fileDataRef.current;
    const fn = useAfpViewerStore.getState().fileName;
    const size = fd?.byteLength ?? 0;

    const rootNode: TreeNode = {
      id: 'sf-root',
      typeId: 'ROOT',
      abbrev: fn || 'AFP File',
      fullName: `AFP Document (${(size / 1024).toFixed(1)} KB)`,
      offset: 0,
      length: size,
      dataPreview: '',
      children: childNodesRef.current,
      depth: 0,
      icon: 'database',
    };

    const newTree = [rootNode];
    const flat = flattenTree(newTree);
    const pMap = buildParentMap(newTree);

    setTree(newTree);
    setAllFlat(flat);
    setParentMap(pMap);
    setLoadedCount(parseStateRef.current?.totalParsed ?? 0);
    setParseDone(parseStateRef.current?.done ?? true);

    return { flat, pMap };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Helper: schedule background chunk loading
  const scheduleBackground = useCallback(() => {
    if (bgTimerRef.current) clearTimeout(bgTimerRef.current);

    const loadNextChunk = () => {
      const ps = parseStateRef.current;
      const fd = fileDataRef.current;
      if (!ps || ps.done || !fd) {
        setParseDone(true);
        return;
      }

      const newState = buildTreeChunk(fd, childNodesRef.current, ps, BG_CHUNK, 1);
      parseStateRef.current = newState;
      updateTreeState();

      if (!newState.done) {
        bgTimerRef.current = setTimeout(loadNextChunk, 100);
      }
    };

    bgTimerRef.current = setTimeout(loadNextChunk, 100);
  }, [updateTreeState]);

  // Helper: parse ahead to a specific byte offset (for page navigation)
  const parseUntilOffset = useCallback((targetOffset: number): { flat: TreeNode[]; pMap: Map<string, string> } | null => {
    const ps = parseStateRef.current;
    const fd = fileDataRef.current;
    if (!ps || ps.done || !fd || ps.offset > targetOffset) return null;

    // Cancel background loading while we parse ahead
    if (bgTimerRef.current) {
      clearTimeout(bgTimerRef.current);
      bgTimerRef.current = null;
    }

    // Parse in chunks until we pass the target offset
    let state = ps;
    while (!state.done && state.offset <= targetOffset) {
      state = buildTreeChunk(fd, childNodesRef.current, state, BG_CHUNK, 1);
    }
    parseStateRef.current = state;

    const result = updateTreeState();

    // Resume background loading if not done
    if (!state.done) {
      scheduleBackground();
    }

    return result;
  }, [updateTreeState, scheduleBackground]);

  // Build tree from file (initial chunk + background progressive loading)
  useEffect(() => {
    // Cancel any previous background loading
    if (bgTimerRef.current) {
      clearTimeout(bgTimerRef.current);
      bgTimerRef.current = null;
    }

    if (status !== 'ready' || !fileData || fileData.byteLength === 0) {
      setTree([]);
      setAllFlat([]);
      setParentMap(new Map());
      parseStateRef.current = null;
      childNodesRef.current = [];
      setLoadedCount(0);
      setParseDone(true);
      return;
    }

    // Parse first chunk synchronously for instant display
    const childNodes: TreeNode[] = [];
    const state = buildTreeChunk(fileData, childNodes, null, INITIAL_CHUNK, 1);
    childNodesRef.current = childNodes;
    parseStateRef.current = state;

    updateTreeState();
    setExpandedIds(new Set(['sf-root']));

    // Continue loading the rest in the background
    if (!state.done) {
      scheduleBackground();
    }

    return () => {
      if (bgTimerRef.current) {
        clearTimeout(bgTimerRef.current);
        bgTimerRef.current = null;
      }
    };
  }, [fileData, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // When page changes, find and select the matching BPG node, expand its ancestors
  useEffect(() => {
    if (!allFlat.length || !pageIndex.length || currentPage < 1) return;
    const entry = pageIndex[currentPage - 1];
    if (!entry) return;

    let flat = allFlat;
    let pMap = parentMap;

    // Find the node at this page's byte offset
    let pageNode = flat.find((n) => n.offset === entry.byteOffset);

    // If not found, the page is beyond the parsed range — parse ahead
    if (!pageNode) {
      const result = parseUntilOffset(entry.byteOffset);
      if (result) {
        flat = result.flat;
        pMap = result.pMap;
        pageNode = flat.find((n) => n.offset === entry.byteOffset);
      }
    }

    if (pageNode) {
      setSelectedElementId(pageNode.id);
      setSelectedNode(pageNode);

      // Expand ancestors
      const ancestors = getAncestorIds(pMap, pageNode.id);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) next.add(a);
        next.add(pageNode!.id); // expand the page node itself
        return next;
      });

      // Scroll to it (deferred so visibleRows/rowIndexById have updated)
      requestAnimationFrame(() => scrollToNode(pageNode!.id));
    }
  }, [currentPage, pageIndex, allFlat, parentMap, setSelectedElementId]); // eslint-disable-line react-hooks/exhaustive-deps

  // React to inspector selection — find node by file offset and scroll to it
  const selectedElementOffset = useAfpViewerStore((s) => s.selectedElementOffset);
  useEffect(() => {
    if (selectedElementOffset === null || allFlat.length === 0) return;

    let flat = allFlat;
    let pMap = parentMap;

    // Find the tree node at this byte offset
    let targetNode = flat.find((n) => n.offset === selectedElementOffset);

    // If not found, parse ahead to reach this offset
    if (!targetNode) {
      const result = parseUntilOffset(selectedElementOffset);
      if (result) {
        flat = result.flat;
        pMap = result.pMap;
        targetNode = flat.find((n) => n.offset === selectedElementOffset);
      }
    }

    if (!targetNode) return;

    setSelectedElementId(targetNode.id);
    setSelectedNode(targetNode);

    // Expand ancestors so the node is visible
    const ancestors = getAncestorIds(pMap, targetNode.id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });

    // Scroll to it
    requestAnimationFrame(() => scrollToNode(targetNode!.id));

    // Clear the offset so it doesn't re-trigger
    useAfpViewerStore.getState().setSelectedElementOffset(null);
  }, [selectedElementOffset, allFlat, parentMap, setSelectedElementId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search logic — uses pre-computed _searchText for instant matching
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!searchQuery.trim()) {
      setMatchIds(new Set());
      setMatchList([]);
      setMatchIndex(-1);
      return;
    }

    // Debounce: wait 150ms after last keystroke
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      const q = searchQuery.toLowerCase();
      const MAX_MATCHES = 1000;
      const matches: TreeNode[] = [];

      for (let i = 0; i < allFlat.length && matches.length < MAX_MATCHES; i++) {
        const n = allFlat[i];
        if (n._searchText && n._searchText.includes(q)) {
          matches.push(n);
        }
      }

      setMatchIds(new Set(matches.map((m) => m.id)));
      setMatchList(matches);
      setMatchIndex(matches.length > 0 ? 0 : -1);

      // Auto-expand paths to FIRST match only (expanding all is too slow for many matches)
      if (matches.length > 0) {
        const firstAncestors = getAncestorIds(parentMap, matches[0].id);
        setExpandedIds((prev) => {
          const next = new Set(prev);
          for (const a of firstAncestors) next.add(a);
          return next;
        });
      }
    }, 150);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery, allFlat, parentMap]);

  // Jump to current match
  useEffect(() => {
    if (matchIndex < 0 || matchIndex >= matchList.length) return;
    const match = matchList[matchIndex];
    setSelectedElementId(match.id);
    setSelectedNode(match);

    // Expand ancestors so the match node is visible
    const ancestors = getAncestorIds(parentMap, match.id);
    if (ancestors.size > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) next.add(a);
        return next;
      });
    }

    // Scroll to the element in the tree
    requestAnimationFrame(() => scrollToNode(match.id));
  }, [matchIndex, matchList, parentMap, setSelectedElementId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback((node: TreeNode) => {
    setSelectedElementId(node.id);
    setSelectedNode(node);
  }, [setSelectedElementId]);

  // Virtualized flat list of visible rows
  const showEndTags = useAfpViewerStore((s) => s.showEndTags);
  const visibleRows = useMemo(
    () => buildVisibleRows(tree, expandedIds, showEndTags),
    [tree, expandedIds, showEndTags],
  );

  // Build a quick id→index map for scroll-to-node
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < visibleRows.length; i++) map.set(visibleRows[i].id, i);
    return map;
  }, [visibleRows]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length + (parseDone ? 0 : 1), // +1 for loading indicator
    getScrollElement: () => containerRef.current,
    estimateSize: () => 28, // row height in px
    overscan: 20,
  });

  // Helper: scroll to a node by id using the virtualizer
  const scrollToNode = useCallback((nodeId: string) => {
    const idx = rowIndexById.get(nodeId);
    if (idx != null) {
      virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
    }
  }, [rowIndexById, virtualizer]);

  const goNextMatch = useCallback(() => {
    if (matchList.length === 0) return;
    setMatchIndex((prev) => (prev + 1) % matchList.length);
  }, [matchList]);

  const goPrevMatch = useCallback(() => {
    if (matchList.length === 0) return;
    setMatchIndex((prev) => (prev - 1 + matchList.length) % matchList.length);
  }, [matchList]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goPrevMatch();
        else goNextMatch();
      }
      if (e.key === 'Escape') {
        setSearchQuery('');
      }
    },
    [goNextMatch, goPrevMatch],
  );

  // Resizable panel width
  const [panelWidth, setPanelWidth] = useState(288); // default 288px = w-72
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    e.preventDefault();

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - ev.clientX; // dragging left = wider
      const newWidth = Math.max(200, Math.min(800, dragStartWidth.current + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  const estimatedTotal = useMemo(() => {
    const ps = parseStateRef.current;
    if (parseDone || !ps || ps.totalParsed === 0 || !fileData) return loadedCount;
    const avgBytes = ps.offset / ps.totalParsed;
    return Math.round(fileData.byteLength / avgBytes);
  }, [parseDone, loadedCount, fileData]);

  if (tree.length === 0) return null;

  return (
    <div className="relative flex h-full shrink-0 flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--card))]" style={{ width: `${panelWidth}px` }}>
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[hsl(var(--primary))]/20 active:bg-[hsl(var(--primary))]/30"
      />
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center border-b border-[hsl(var(--border))] px-3">
        <FileText className="mr-2 h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
          AFP Elements
        </span>
        <span className="ml-1 text-[10px] text-[hsl(var(--muted-foreground))]">
          {loadedCount.toLocaleString()}{!parseDone && ` / ~${estimatedTotal.toLocaleString()}…`}
        </span>
        <div className="ml-auto relative">
          <SettingsMenu />
        </div>
      </div>

      {/* Search bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[hsl(var(--border))] px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))]" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search elements..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          className="h-6 flex-1 bg-transparent text-xs text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
        />
        {matchList.length > 0 && (
          <div className="flex items-center gap-0.5">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {matchIndex + 1}/{matchList.length}
            </span>
            <button onClick={goPrevMatch} className="rounded p-0.5 hover:bg-[hsl(var(--accent))]">
              <ChevronUp className="h-3 w-3" />
            </button>
            <button onClick={goNextMatch} className="rounded p-0.5 hover:bg-[hsl(var(--accent))]">
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        )}
        {searchQuery && matchList.length === 0 && (
          <span className="text-[10px] text-[hsl(var(--destructive))]">No matches</span>
        )}
      </div>

      {/* Tree (virtualized) */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            // Loading indicator row (last virtual item when still loading)
            if (vRow.index >= visibleRows.length) {
              return (
                <div
                  key="__loading__"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${vRow.size}px`, transform: `translateY(${vRow.start}px)` }}
                  className="flex items-center justify-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))]"
                >
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-[hsl(var(--primary))] border-t-transparent" />
                  Loading more elements…
                </div>
              );
            }
            const node = visibleRows[vRow.index];
            return (
              <div
                key={node.id}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${vRow.size}px`, transform: `translateY(${vRow.start}px)` }}
              >
                <FlatTreeRow
                  node={node}
                  isSelected={selectedId === node.id}
                  isMatch={matchIds.has(node.id)}
                  isExpanded={expandedIds.has(node.id)}
                  hasChildren={node.children.length > 0}
                  onToggle={handleToggle}
                  onSelect={handleSelect}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Details panel */}
      {selectedNode && (
        <ElementDetailPanel node={selectedNode} fileData={fileData} onNodeUpdate={setSelectedNode} />
      )}

    </div>
  );
}

/** Extracts and displays font resources found in the AFP document. */
function FontInfoPanel({ fileData }: { fileData: ArrayBuffer }) {
  const fonts = useMemo(() => {
    const view = new DataView(fileData);
    const results: { name: string; type: string; weight: string; codePage: string; family: string }[] = [];
    const seen = new Set<string>();

    function decodeEbcdic(data: DataView | ArrayBuffer, start: number, len: number): string {
      const v = data instanceof DataView ? data : new DataView(data);
      let s = '';
      for (let i = start; i < start + len; i++) {
        const b = v.getUint8(i);
        if (b === 0x40) s += ' ';
        else if (b >= 0xC1 && b <= 0xC9) s += String.fromCharCode(65 + b - 0xC1);
        else if (b >= 0xD1 && b <= 0xD9) s += String.fromCharCode(74 + b - 0xD1);
        else if (b >= 0xE2 && b <= 0xE9) s += String.fromCharCode(83 + b - 0xE2);
        else if (b >= 0xF0 && b <= 0xF9) s += String.fromCharCode(48 + b - 0xF0);
        else if (b >= 0x20 && b < 0x7F) s += String.fromCharCode(b);
      }
      return s.trim();
    }

    let currentBOC = '';
    let currentFamily = '';
    let offset = 0;

    while (offset < fileData.byteLength - 9) {
      if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
      const len = view.getUint16(offset + 1, false);
      if (len < 6 || len > 32766) { offset++; continue; }
      const typeId = view.getUint8(offset + 3).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 4).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 5).toString(16).toUpperCase().padStart(2, '0');
      const dl = len - 8;

      // BOC — track current container name
      if (typeId === 'D3A8CE' && dl >= 8) {
        currentBOC = decodeEbcdic(view, offset + 9, 8);
        currentFamily = '';
      }

      // CPD (D3A689) — Code Page/Font Descriptor contains the font family name
      if (typeId === 'D3A689' && dl > 10 && currentBOC.startsWith('C0F')) {
        currentFamily = decodeEbcdic(view, offset + 9, Math.min(dl, 32));
      }

      // EOC — finalize the font entry
      if (typeId === 'D3A9CE' && currentBOC && !seen.has(currentBOC)) {
        if (currentBOC.startsWith('C0F') || currentBOC.startsWith('T1')) {
          seen.add(currentBOC);
          let type = 'Unknown';
          let weight = 'Regular';
          let codePage = '';
          const suffix = currentBOC.slice(-2);

          if (currentBOC.startsWith('C0FL')) {
            type = 'Latin';
            weight = { '60': 'Light', '70': 'Medium', '80': 'Bold', '90': 'Light Italic', 'A0': 'Bold Italic', 'B0': 'Semi-Bold', 'C0': 'Condensed', 'E0': 'Condensed Bold' }[suffix] || weight;
          } else if (currentBOC.startsWith('C0FM')) {
            type = 'Math/Symbol';
            weight = { '60': 'Light', '70': 'Medium', '80': 'Bold', '90': 'Italic', 'A0': 'Bold Italic', 'B0': 'Semi-Bold', 'C0': 'Condensed', 'E0': 'Condensed Bold', 'I0': 'Std Italic' }[suffix] || weight;
          } else if (currentBOC.startsWith('T1')) {
            type = 'Code Page';
            weight = '—';
            codePage = currentBOC.includes('1144') ? 'CP297 (French)' : currentBOC.includes('0500') ? 'CP500 (Intl)' : currentBOC;
          }

          results.push({ name: currentBOC, type, weight, codePage, family: currentFamily });
        }
      }

      if (typeId === 'D3A8AD') break;
      const next = offset + 1 + len;
      if (next <= offset) break;
      offset = next;
    }

    return results;
  }, [fileData]);

  if (fonts.length === 0) return null;

  const charSets = fonts.filter(f => f.type !== 'Code Page');
  const codePages = fonts.filter(f => f.type === 'Code Page');

  return (
    <div className="shrink-0 border-t border-[hsl(var(--border))] p-3 max-h-[300px] overflow-auto">
      <p className="text-[10px] font-semibold text-[hsl(var(--primary))]">Document Fonts</p>

      {codePages.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">Code Pages</p>
          {codePages.map(cp => (
            <div key={cp.name} className="mt-0.5 flex items-center gap-2 text-[10px]">
              <span className="font-mono text-[hsl(var(--foreground))]">{cp.name}</span>
              <span className="text-[hsl(var(--muted-foreground))]">{cp.codePage}</span>
            </div>
          ))}
        </div>
      )}

      {charSets.length > 0 && (
        <div className="mt-2">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">Character Sets ({charSets.length})</p>
          <div className="mt-0.5 space-y-1">
            {charSets.map(f => (
              <div key={f.name} className="text-[10px]">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[hsl(var(--foreground))]">{f.name}</span>
                  <span className={f.weight.includes('Bold') ? 'font-bold text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]'}>
                    {f.weight}
                  </span>
                </div>
                {f.family && (
                  <p className="ml-0.5 text-[9px] text-[hsl(var(--muted-foreground))]">{f.family}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Convert ASCII/Unicode char to EBCDIC byte (CP037). Returns 0x40 (space) for unmapped. */
function charToEbcdic(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 73) return 0xC1 + (c - 65);   // A-I
  if (c >= 74 && c <= 82) return 0xD1 + (c - 74);   // J-R
  if (c >= 83 && c <= 90) return 0xE2 + (c - 83);   // S-Z
  if (c >= 97 && c <= 105) return 0x81 + (c - 97);  // a-i
  if (c >= 106 && c <= 114) return 0x91 + (c - 106); // j-r
  if (c >= 115 && c <= 122) return 0xA2 + (c - 115); // s-z
  if (c >= 48 && c <= 57) return 0xF0 + (c - 48);   // 0-9
  if (c === 32) return 0x40;  // space
  if (c === 46) return 0x4B;  // .
  if (c === 44) return 0x6B;  // ,
  if (c === 39) return 0x7D;  // '
  if (c === 45) return 0x60;  // -
  if (c === 47) return 0x61;  // /
  if (c === 38) return 0x50;  // &
  if (c === 95) return 0x6D;  // _
  if (c === 58) return 0x7A;  // :
  if (c === 64) return 0x7C;  // @
  if (c === 42) return 0x5C;  // *
  if (c === 40) return 0x4D;  // (
  if (c === 41) return 0x5D;  // )
  if (c === 61) return 0x7E;  // =
  if (c === 43) return 0x4E;  // +
  if (c === 59) return 0x5E;  // ;
  if (c === 37) return 0x6C;  // %
  if (c === 35) return 0x7B;  // #
  if (c === 36) return 0x5B;  // $
  return 0x40; // default to space
}

/** Write an ASCII string as EBCDIC bytes into a buffer, padding with spaces. */
function writeEbcdic(bytes: Uint8Array, offset: number, maxLen: number, text: string): void {
  for (let i = 0; i < maxLen; i++) {
    if (i < text.length) {
      bytes[offset + i] = charToEbcdic(text[i]);
    } else {
      bytes[offset + i] = 0x40; // pad with EBCDIC space
    }
  }
}

// Editable element types
const EDITABLE_TYPES = new Set(['D3A090', 'D3EEEE', 'D3AFEE', 'D3A8EE']); // TLE, NOP

function isEditable(typeId: string): boolean {
  return EDITABLE_TYPES.has(typeId);
}

function ElementDetailPanel({ node, fileData, onNodeUpdate }: { node: TreeNode; fileData: ArrayBuffer | null; onNodeUpdate: (n: TreeNode) => void }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saved, setSaved] = useState(false);

  const canEdit = isEditable(node.typeId) && fileData;

  // Image preview for image-related nodes
  const imageTypes = new Set([
    'D3EEBB', 'D3EEFB', 'D3EE7B', 'D3EE92', // OCD, IRD, IDE, IID data
    'D3A8FB', 'D3A892',                        // BII (Begin IM Image)
    'D3A8C5',                                   // BIM (Begin IOCA Image)
    'D3A8BB',                                   // BDI (Begin Document Index - contains OCD)
  ]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);

  useEffect(() => {
    setImageUrl(null);
    setPreviewZoom(1);
    if (!fileData || !imageTypes.has(node.typeId)) return;

    const loadPreview = async () => {

    try {
      const dataStart = node.offset + 9;
      const dataLen = node.length - 8;
      if (dataStart + dataLen > fileData.byteLength) return;

      const bytes = new Uint8Array(fileData, dataStart, Math.min(dataLen, 50000));

      // Detect image format from magic bytes
      let mimeType = '';
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) mimeType = 'image/jpeg';
      else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) mimeType = 'image/png';
      else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) mimeType = 'image/gif';
      else if (bytes[0] === 0x42 && bytes[1] === 0x4D) mimeType = 'image/bmp';
      else if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4D && bytes[1] === 0x4D)) mimeType = 'image/tiff';
      else if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) mimeType = 'application/pdf';
      else if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00) {
        // Could be various container formats — skip
      }

      if (mimeType) {
        const fullBytes = new Uint8Array(fileData, dataStart, dataLen);
        const blob = new Blob([fullBytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        setImageUrl(url);
        return () => URL.revokeObjectURL(url);
      }

      // GOCA vector QR codes: scan ALL OCD blocks in the file for GBOX patterns
      // Works for OCD, BDI, BPS, BOC nodes — combines all nearby OCDs
      if (typeof document !== 'undefined') {
        // Collect ALL OCD data from the file near this node
        const scanStart = Math.max(0, node.offset - 100);
        const scanEnd = Math.min(fileData.byteLength, node.offset + 200000);
        const scanView = new DataView(fileData);
        const allOcdBytes: number[] = [];
        let scanOff = scanStart;
        let foundOcd = false;

        while (scanOff < scanEnd) {
          if (scanView.getUint8(scanOff) !== 0x5A) { scanOff++; continue; }
          if (scanOff + 9 > scanEnd) break;
          const sLen = scanView.getUint16(scanOff + 1, false);
          if (sLen < 6 || sLen > 32766) { scanOff++; continue; }
          const t = scanView.getUint8(scanOff+3).toString(16).toUpperCase().padStart(2,'0') +
            scanView.getUint8(scanOff+4).toString(16).toUpperCase().padStart(2,'0') +
            scanView.getUint8(scanOff+5).toString(16).toUpperCase().padStart(2,'0');
          if (t === 'D3EEBB') {
            foundOcd = true;
            const dLen = sLen - 8;
            for (let k = 0; k < dLen && scanOff+9+k < fileData.byteLength; k++) {
              allOcdBytes.push(scanView.getUint8(scanOff + 9 + k));
            }
          }
          scanOff += 1 + sLen;
        }

        if (foundOcd && allOcdBytes.length > 100) {
          // Extract GBOX rectangles
          const rects: Array<[number, number, number, number]> = [];
          for (let j = 0; j < allOcdBytes.length - 13; j++) {
            if (allOcdBytes[j] === 0x68 && allOcdBytes[j+1] === 0x80 &&
                allOcdBytes[j+2] === 0xC0 && allOcdBytes[j+3] === 0x0A) {
              rects.push([
                (allOcdBytes[j+6]<<8)|allOcdBytes[j+7], (allOcdBytes[j+8]<<8)|allOcdBytes[j+9],
                (allOcdBytes[j+10]<<8)|allOcdBytes[j+11], (allOcdBytes[j+12]<<8)|allOcdBytes[j+13],
              ]);
            }
          }
          if (rects.length > 10) {
            let mx = 0, my = 0;
            for (const [x1,y1,x2,y2] of rects) { mx = Math.max(mx,x1,x2); my = Math.max(my,y1,y2); }
            const sz = Math.max(mx, my) + 10;
            const sc = 300 / sz;
            const c = document.createElement('canvas');
            c.width = 300; c.height = 300;
            const cx = c.getContext('2d');
            if (cx) {
              cx.fillStyle = '#FFF'; cx.fillRect(0,0,300,300);
              cx.fillStyle = '#000';
              for (const [x1,y1,x2,y2] of rects) {
                const rx = Math.min(x1,x2)*sc, ry = (sz-Math.max(y1,y2))*sc;
                const rw = Math.abs(x2-x1)*sc, rh = Math.abs(y2-y1)*sc;
                cx.fillRect(rx, ry, Math.max(1,rw), Math.max(1,rh));
              }
              setImageUrl(c.toDataURL('image/png'));
              return;
            }
          }
        }
      }

      // Legacy IM Image raster: parse the specific BII block at this node's offset
      try {
        const { parseIMImageAt, renderIMImageToDataUrl } = await import('@/lib/afp/im-image-parser');
        // For BII nodes, scan from the node's offset. For IRD nodes, scan backward to find parent BII.
        const scanStart = node.typeId === 'D3A8FB' ? node.offset : Math.max(0, node.offset - 2000);
        const img = parseIMImageAt(fileData, scanStart);
        if (img) {
          const url = renderIMImageToDataUrl(img);
          if (url) setImageUrl(url);
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    };
    loadPreview();
  }, [node, fileData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse TLE key/value for editing
  const tleInfo = node.typeId === 'D3A090' ? parseTLETriplets(
    fileData ? new Uint8Array(fileData, node.offset + 9, Math.min(node.length - 8, 300)) : new Uint8Array(0)
  ) : null;

  // Decode text content for BPT nodes by reading their PTX children
  const textContent = useMemo(() => {
    if (!fileData || (node.typeId !== 'D3A87B' && node.typeId !== 'D3A89B')) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parsePTOCA } = require('@/lib/ptoca/parser');
      // Collect PTX data from children
      const ptxTypes = new Set(['D3EE7B', 'D3EE9B', 'D3EE6B']);
      const chunks: Uint8Array[] = [];
      for (const child of node.children) {
        if (ptxTypes.has(child.typeId)) {
          const start = child.offset + 9;
          const len = child.length - 8;
          if (start + len <= fileData.byteLength && len > 0) {
            chunks.push(new Uint8Array(fileData, start, len));
          }
        }
      }
      if (chunks.length === 0) return null;
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      const parsed = parsePTOCA(all);
      if (parsed.runs.length === 0) return null;
      return parsed.runs.map((r: { text: string }) => r.text).join('');
    } catch { return null; }
  }, [node, fileData]);

  const startEdit = () => {
    if (tleInfo) {
      const parts = tleInfo.split(' = ');
      setEditValue(parts.length > 1 ? parts.slice(1).join(' = ') : tleInfo);
    } else {
      setEditValue(node.dataPreview);
    }
    setEditing(true);
    setSaved(false);
  };

  const saveEdit = () => {
    if (!fileData) return;

    try {
      const bytes = new Uint8Array(fileData);
      const fieldStart = node.offset + 9; // skip 0x5A + LENGTH(2) + TYPE(3) + FLAGS(1) + SEQ(2)
      const fieldEnd = node.offset + 1 + node.length;
      const dataLen = fieldEnd - fieldStart;

      if (node.typeId === 'D3A090') {
        // TLE: find the 0x36 triplet (attribute value) and overwrite its EBCDIC content
        let j = fieldStart;
        while (j < fieldEnd) {
          const tlen = bytes[j];
          if (tlen < 2 || j + tlen > fieldEnd) break;
          const tid = bytes[j + 1];
          if (tid === 0x36 && tlen > 4) {
            // Value data starts at j+4, length = tlen-4
            const valueStart = j + 4;
            const valueLen = tlen - 4;
            writeEbcdic(bytes, valueStart, valueLen, editValue);
            break;
          }
          j += tlen;
        }
      } else {
        // PTD/NOP: overwrite the entire data section with EBCDIC
        writeEbcdic(bytes, fieldStart, dataLen, editValue);
      }

      // Update the node's dataPreview
      node.dataPreview = getDataPreview(
        bytes.slice(fieldStart, fieldStart + Math.min(dataLen, 60)),
        node.typeId,
      );

      setEditing(false);
      setSaved(true);
      // Notify parent to update display
      onNodeUpdate({ ...node });
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  return (
    <div className="shrink-0 border-t border-[hsl(var(--border))] p-3 max-h-[250px] overflow-auto">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-[hsl(var(--foreground))]">{node.abbrev}</p>
        {canEdit && !editing && (
          <button
            onClick={startEdit}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))]"
          >
            Edit
          </button>
        )}
      </div>
      <p className="text-[10px] text-[hsl(var(--primary))]">{node.fullName}</p>
      <div className="mt-1.5 space-y-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
        <p>Type ID: {node.typeId}</p>
        <p>Offset: {node.offset}</p>
        <p>Length: {node.length} bytes</p>
        {node.children.length > 0 && <p>Children: {node.children.length}</p>}
      </div>

      {/* TLE key=value display */}
      {tleInfo && !editing && (
        <div className="mt-2 rounded bg-[hsl(var(--muted))] p-1.5">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">TLE Value</p>
          <p className="mt-0.5 break-all font-mono text-[10px] leading-tight text-[hsl(var(--foreground))]">
            {tleInfo}
          </p>
        </div>
      )}

      {/* Text content for BPT elements */}
      {textContent && !editing && (
        <div className="mt-2 rounded bg-[hsl(var(--muted))] p-1.5">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">Text Content</p>
          <p className="mt-0.5 max-h-[200px] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-tight text-[hsl(var(--foreground))]">
            {textContent}
          </p>
        </div>
      )}

      {/* Non-TLE data preview */}
      {!tleInfo && !textContent && node.dataPreview && !editing && (
        <div className="mt-2 rounded bg-[hsl(var(--muted))] p-1.5">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">Data (ASCII)</p>
          <p className="mt-0.5 break-all font-mono text-[10px] leading-tight text-[hsl(var(--foreground))]">
            {node.dataPreview}
          </p>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <div className="mt-2">
          <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">
            {tleInfo ? 'Edit TLE Value' : 'Edit Data'}
          </p>
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="mt-1 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1.5 font-mono text-[10px] text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
            rows={3}
          />
          <div className="mt-1 flex gap-1">
            <button
              onClick={saveEdit}
              className="rounded bg-[hsl(var(--primary))] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--primary-foreground))]"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {saved && (
        <p className="mt-1 text-[10px] font-medium text-green-600">Saved successfully</p>
      )}

      {/* Image/PDF preview */}
      {imageUrl && (
        <div className="mt-2 rounded bg-white p-1">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-medium text-[hsl(var(--muted-foreground))]">Preview</p>
            {!imageUrl.includes('pdf') && (
              <div className="flex items-center gap-0.5">
                <button
                  className="rounded px-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
                  onClick={() => setPreviewZoom(z => Math.max(0.25, z - 0.25))}
                  title="Zoom out"
                >−</button>
                <span className="min-w-[28px] text-center text-[9px] text-[hsl(var(--muted-foreground))]">{Math.round(previewZoom * 100)}%</span>
                <button
                  className="rounded px-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
                  onClick={() => setPreviewZoom(z => Math.min(4, z + 0.25))}
                  title="Zoom in"
                >+</button>
                <button
                  className="rounded px-1 text-[9px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
                  onClick={() => setPreviewZoom(1)}
                  title="Reset zoom"
                >↺</button>
              </div>
            )}
          </div>
          {imageUrl.includes('pdf') ? (
            <iframe
              src={imageUrl}
              className="mt-1 h-48 w-full rounded border-0"
              title="Embedded PDF"
            />
          ) : (
            <div
              className="mt-1 overflow-auto rounded"
              style={{ maxHeight: '250px', background: '#f8f8f8' }}
            >
              <img
                src={imageUrl}
                alt="Embedded graphic"
                className="border-0"
                style={{
                  width: previewZoom === 1 ? '100%' : undefined,
                  transform: previewZoom !== 1 ? `scale(${previewZoom})` : undefined,
                  transformOrigin: 'top left',
                  display: 'block',
                  maxWidth: previewZoom === 1 ? '100%' : 'none',
                }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const showEndTags = useAfpViewerStore((s) => s.showEndTags);
  const showPlaceholders = useAfpViewerStore((s) => s.showPlaceholders);
  const docDividerTle = useAfpViewerStore((s) => s.docDividerTle);
  const fileData = useAfpViewerStore((s) => s.fileData);

  // Extract unique TLE keys from first few pages for the dropdown
  const tleKeys = useMemo(() => {
    if (!fileData) return [];
    const keys = new Set<string>();
    const view = new DataView(fileData);
    let offset = 0;
    let pagesSeen = 0;

    while (offset < fileData.byteLength - 9 && pagesSeen < 3) {
      if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
      const len = view.getUint16(offset + 1, false);
      if (len < 6 || len > 32766) { offset++; continue; }
      const t3 = view.getUint8(offset + 3);
      const t4 = view.getUint8(offset + 4);
      const t5 = view.getUint8(offset + 5);

      if (t3 === 0xD3 && t4 === 0xA8 && t5 === 0xAD) pagesSeen++; // BPG

      // TLE (D3A090)
      if (t3 === 0xD3 && t4 === 0xA0 && t5 === 0x90) {
        const dl = len - 8;
        let tp = offset + 9;
        const tEnd = offset + 9 + dl;
        while (tp + 4 < tEnd) {
          const tLen = view.getUint8(tp);
          const tId = view.getUint8(tp + 1);
          if (tLen < 2 || tp + tLen > tEnd) break;
          if (tId === 0x02 && tLen > 4) {
            let key = '';
            for (let i = tp + 4; i < tp + tLen; i++) {
              const b = view.getUint8(i);
              if (b === 0x40) key += '_';
              else if (b >= 0xC1 && b <= 0xC9) key += String.fromCharCode(65 + b - 0xC1);
              else if (b >= 0xD1 && b <= 0xD9) key += String.fromCharCode(74 + b - 0xD1);
              else if (b >= 0xE2 && b <= 0xE9) key += String.fromCharCode(83 + b - 0xE2);
              else if (b >= 0xF0 && b <= 0xF9) key += String.fromCharCode(48 + b - 0xF0);
              else if (b >= 0x81 && b <= 0x89) key += String.fromCharCode(97 + b - 0x81);
              else if (b >= 0x91 && b <= 0x99) key += String.fromCharCode(106 + b - 0x91);
              else if (b >= 0xA2 && b <= 0xA9) key += String.fromCharCode(115 + b - 0xA2);
              else if (b === 0x6D) key += '_';
              else if (b === 0x7D) key += "'";
              else if (b === 0x60) key += '-';
            }
            key = key.replace(/_+$/, '').trim();
            if (key.length > 1) keys.add(key);
          }
          tp += tLen;
        }
      }

      const next = offset + 1 + len;
      if (next <= offset) break;
      offset = next;
    }
    return [...keys].sort();
  }, [fileData]);

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="rounded p-0.5 hover:bg-[hsl(var(--accent))]"
        aria-label="Settings"
      >
        <Settings2 className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-20 w-56 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2 shadow-lg">
          <p className="mb-1.5 text-[10px] font-semibold text-[hsl(var(--muted-foreground))]">
            Settings
          </p>
          <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-[hsl(var(--accent))]">
            <input
              type="checkbox"
              checked={showEndTags}
              onChange={() => useAfpViewerStore.setState({ showEndTags: !showEndTags })}
              className="h-3 w-3 rounded"
            />
            <span className="text-[11px] text-[hsl(var(--foreground))]">Show END tags</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-[hsl(var(--accent))]">
            <input
              type="checkbox"
              checked={showPlaceholders}
              onChange={() => useAfpViewerStore.getState().togglePlaceholders()}
              className="h-3 w-3 rounded"
            />
            <span className="text-[11px] text-[hsl(var(--foreground))]">Show placeholders</span>
          </label>

        </div>
      )}
    </>
  );
}

function countNodes(node: TreeNode): number {
  let count = 0;
  for (const child of node.children) {
    count += 1 + countNodes(child);
  }
  return count;
}
