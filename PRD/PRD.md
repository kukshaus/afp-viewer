# Product Requirements Document
# AFP Viewer — High-Performance Web Application

**Version:** 1.0  
**Date:** 2026-03-31  
**Status:** Draft  
**Owner:** Product Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background & Format Deep Dive](#2-background--format-deep-dive)
3. [Problem Statement](#3-problem-statement)
4. [Goals & Non-Goals](#4-goals--non-goals)
5. [User Personas](#5-user-personas)
6. [Functional Requirements](#6-functional-requirements)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Technical Architecture](#8-technical-architecture)
9. [AFP Parsing Strategy](#9-afp-parsing-strategy)
10. [Pagination & Large File Strategy](#10-pagination--large-file-strategy)
11. [Rendering Pipeline](#11-rendering-pipeline)
12. [UI/UX Requirements](#12-uiux-requirements)
13. [API Design](#13-api-design)
14. [Technology Stack](#14-technology-stack)
15. [Data Models](#15-data-models)
16. [Security Requirements](#16-security-requirements)
17. [Performance Targets](#17-performance-targets)
18. [Milestones & Roadmap](#18-milestones--roadmap)
19. [Open Questions](#19-open-questions)
20. [Appendix: AFP Reference Summary](#20-appendix-afp-reference-summary)

---

## 1. Executive Summary

AFP Viewer is a high-performance, browser-based web application built with Next.js for viewing IBM AFP (Advanced Function Presentation) documents. It must handle files up to 2 GB containing millions of pages/documents with sub-second page navigation, intelligent streaming, on-demand rendering, and full fidelity visual output including text (PTOCA), images (IOCA), graphics (GOCA), bar codes (BCOCA), and fonts (FOCA).

---

## 2. Background & Format Deep Dive

### 2.1 What Is AFP?

AFP (Advanced Function Presentation) is an IBM print data-stream architecture developed in the 1980s for high-volume transactional printing. It is the backbone of statements, insurance documents, cheques, and financial reports produced on IBM mainframe (z/OS), IBM i (AS/400), and distributed systems.

AFP is governed by:
- **MO:DCA** — Mixed Object Document Content Architecture (the container/wrapper format)
- **PTOCA** — Presentation Text Object Content Architecture (formatted text)
- **IOCA** — Image Object Content Architecture (raster & vector images)
- **GOCA** — Graphics Object Content Architecture (vector graphics)
- **BCOCA** — Bar Code Object Content Architecture (1D/2D barcodes)
- **FOCA** — Font Object Content Architecture (font definitions)
- **CMOCA** — Color Management Object Content Architecture
- **MOCA** — Metadata Object Content Architecture

Standards are maintained by the **AFP Consortium** (https://afpcinc.org). The latest specifications (as of 2026) are:

| Spec | Version |
|------|---------|
| MO:DCA | AFPC-0004-10 |
| PTOCA | AFPC-0009-04 (Feb 2025) |
| IOCA | AFPC-0003-09 (2024) |
| BCOCA | AFPC-0005-11 (Dec 2025) |
| CMOCA | AFPC-0006-02 (Jun 2025) |
| MOCA | AFPC-0013-02 (Mar 2025) |

### 2.2 Binary Structure

Every AFP file is a sequence of **Structured Fields**. Each field has the following binary layout:

```
Offset  Size   Field
------  ----   -----
0       1      Carriage Control: 0x5A (magic byte, always present)
1       2      LENGTH: big-endian length of bytes 1..end (excludes 0x5A)
3       3      TYPE ID: 3-byte hex identifying the structured field type
6       1      FLAGS: extension, segmented, padding indicators
7       2      SEQUENCE NUMBER: optional sequence ID
9       N      DATA: parameter bytes (N = LENGTH - 8)
```

A parser advances by reading:
1. Seek until `0x5A` byte
2. Read 2-byte length → `len`
3. Read 3-byte type ID → dispatch to handler
4. Skip `len - 5` bytes (or read if needed) to advance to next field

### 2.3 Document Hierarchy

```
BDT  (Begin Document)
 ├─ Resource Group  [optional inline fonts/overlays/page-segs]
 │   ├─ BCF/ECF   Coded Font
 │   ├─ BFN/EFN   Font
 │   └─ BPS/EPS   Page Segment
 ├─ BNG  (Begin Named Group) — groups of documents/pages
 │   └─ BPG/EPG  (Begin/End Page Group)
 │       ├─ BPG/EPG  (Begin/End Page)  ← ONE PAGE
 │       │   ├─ BAG/EAG  Object Area
 │       │   ├─ BPT/EPT  Begin Presentation Text  (PTOCA)
 │       │   │   ├─ PTD   Presentation Text Descriptor
 │       │   │   └─ PTX   Presentation Text Data
 │       │   ├─ BIM/EIM  Begin Image  (IOCA)
 │       │   │   ├─ IDD   Image Data Descriptor
 │       │   │   └─ IDE   Image Data Element
 │       │   ├─ BGR/EGR  Begin Graphics  (GOCA)
 │       │   │   └─ GAD   Graphics Data
 │       │   └─ BBC/EBC  Begin Bar Code  (BCOCA)
 │       │       ├─ BDD   Bar Code Descriptor
 │       │       └─ BDA   Bar Code Data
 │       └─ EPG
 └─ ENG  (End Named Group)
EDT  (End Document)
```

A single `.afp` file can contain multiple logical documents (named groups), each with thousands of pages. A 2 GB production file may contain millions of pages.

### 2.4 Resource Resolution

AFP resources (fonts, overlays, page segments, form definitions) can be:
- **Inline** — embedded within the AFP stream before use
- **External** — referenced by name, expected in a resource library at print time

The viewer must handle both cases, and gracefully degrade when external resources are unavailable (use fallback fonts, render placeholder images).

### 2.5 Coordinates & Measurement

- AFP uses **L-units** (logical units). Common resolution: 1440 L-units = 1 inch.
- Page origin is top-left corner.
- All positions (text baseline, image placement, graphics coordinates) are in L-units relative to the active page/object area origin.
- Conversion for display: `pixels = (l_units / resolution_lpu) * dpi * zoom_factor`

### 2.6 Text Rendering (PTOCA)

PTOCA defines a stateful text rendering model:
- **AMI/RMI** — Absolute/Relative Move Inline (horizontal position)
- **AMB/RMB** — Absolute/Relative Move Baseline (vertical position)
- **STO** — Set Text Orientation
- **SVI** — Set Variable Space Increment
- **TRN** — Transparent Data (the actual text bytes)
- **SEC** — Set Extended Color

Fonts are referenced by a 2-byte Local Font ID mapped to the active coded font resource (FOCA). EBCDIC or Unicode encoding depending on code page.

### 2.7 EBCDIC & Code Pages

Many AFP files encode text in **EBCDIC** (IBM's Extended Binary Coded Decimal Interchange Code). The viewer must:
1. Identify the active code page for each text object
2. Transcode EBCDIC → UTF-8 for display
3. Handle multi-byte DBCS (Double Byte Character Set) code pages for CJK

---

## 3. Problem Statement

There is no modern, open, high-performance web-based AFP viewer available. Existing tools are:
- Desktop-only, expensive commercial software (e.g., AFP Workbench, ViewDirect)
- Java-based legacy viewers (slow, no mobile support)
- Converters (AFP→PDF) that lose fidelity and are slow for large files

Users who work with AFP documents — in banking, insurance, government, telecom — cannot quickly view these documents in a browser, navigate to specific pages, or search content without heavy infrastructure.

---

## 4. Goals & Non-Goals

### Goals

- **G1** — View AFP files up to 2 GB in a browser without full upfront loading
- **G2** — Navigate to any page within 500ms regardless of document size
- **G3** — Render text (PTOCA), images (IOCA), graphics (GOCA), and barcodes (BCOCA) faithfully
- **G4** — Support multi-document AFP files (navigate by document AND page)
- **G5** — Full-text search within the document
- **G6** — Export individual pages or page ranges to PDF/PNG
- **G7** — Responsive web UI accessible on desktop and tablet
- **G8** — Drag-and-drop file upload, no server infrastructure required for small files (client-side WASM parser option)
- **G9** — Thumbnail strip for quick visual page navigation

### Non-Goals

- Creating or editing AFP documents
- Print output (AFP → printer)
- Full support for AFP/A (archival) or IPDS (printer protocol)
- Real-time streaming from a mainframe print spooler (v1)
- Mobile native app

---

## 5. User Personas

### 5.1 Enterprise Document Analyst — "Maria"
- Works in insurance; receives daily AFP files containing millions of policy documents
- Needs to quickly find a specific customer's document within a huge file
- Non-technical; expects a simple, fast web UI
- Pain point: current desktop tool crashes on files > 500 MB

### 5.2 Print Operations Engineer — "James"
- Manages print infrastructure at a bank
- Needs to inspect AFP structure (structured fields) for debugging
- Technical; wants hex-level inspection and metadata view
- Pain point: no browser-based AFP debugger exists

### 5.3 Software Developer — "Aiko"
- Building document management software
- Wants to embed AFP viewing in her company's portal
- Pain point: no embeddable AFP viewer component

### 5.4 Compliance Officer — "Robert"
- Needs to verify regulatory documents (statements, notices) match expected layout
- Wants page comparison and annotation features
- Pain point: no way to overlay expected vs actual AFP output

---

## 6. Functional Requirements

### 6.1 File Loading

| ID | Requirement | Priority |
|----|-------------|----------|
| F-01 | Accept AFP file upload via drag-and-drop or file picker | P0 |
| F-02 | Accept AFP file URL for server-side streaming | P0 |
| F-03 | Support files up to 2 GB | P0 |
| F-04 | Display file load progress indicator | P1 |
| F-05 | Persist recently loaded files in browser (IndexedDB) | P2 |
| F-06 | Support chunked HTTP range requests for remote files | P0 |

### 6.2 Document Index & Navigation

| ID | Requirement | Priority |
|----|-------------|----------|
| F-10 | Build a page index (byte offset per page) during initial scan | P0 |
| F-11 | Display total page count as soon as index scan completes | P0 |
| F-12 | Navigate to any page by number via input field | P0 |
| F-13 | Previous/next page buttons with keyboard shortcuts | P0 |
| F-14 | Jump to named document (multi-document AFP files) | P1 |
| F-15 | Display document tree (named groups hierarchy) | P1 |
| F-16 | Paginated thumbnail strip (virtual-scrolled) | P1 |
| F-17 | Bookmark pages | P2 |

### 6.3 Rendering

| ID | Requirement | Priority |
|----|-------------|----------|
| F-20 | Render PTOCA text with correct position, font, and size | P0 |
| F-21 | Render IOCA raster images (JPEG, CCITT Fax G3/G4, MO:DCA IOCA) | P0 |
| F-22 | Render GOCA vector graphics (lines, arcs, filled areas) | P1 |
| F-23 | Render BCOCA bar codes (Code 39, Code 128, QR via canvas) | P1 |
| F-24 | Apply overlays and page segments | P1 |
| F-25 | Correct EBCDIC to UTF-8 transcoding with code page awareness | P0 |
| F-26 | Zoom in/out (25% to 400%) with smooth canvas scaling | P0 |
| F-27 | Fit-to-width and fit-to-page view modes | P0 |
| F-28 | Page rotation (0°, 90°, 180°, 270°) | P1 |
| F-29 | Render pages in correct L-unit coordinate space | P0 |
| F-30 | Graceful fallback for unsupported structured fields | P0 |

### 6.4 Search

| ID | Requirement | Priority |
|----|-------------|----------|
| F-40 | Full-text search across all pages (PTOCA text extraction) | P1 |
| F-41 | Search results panel showing page number + text excerpt | P1 |
| F-42 | Highlight search matches on rendered page | P1 |
| F-43 | Next/previous match navigation | P1 |

### 6.5 Export

| ID | Requirement | Priority |
|----|-------------|----------|
| F-50 | Export current page as PNG | P1 |
| F-51 | Export page range as multi-page PDF | P1 |
| F-52 | Export structured field metadata as JSON | P2 |

### 6.6 Developer / Inspect Mode

| ID | Requirement | Priority |
|----|-------------|----------|
| F-60 | Structured field inspector panel (for engineers) | P2 |
| F-61 | Display hex dump of selected structured field | P2 |
| F-62 | Show parsed metadata per page (field counts, image sizes, etc.) | P2 |

---

## 7. Non-Functional Requirements

### 7.1 Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NF-01 | Initial page index scan for a 2 GB file | < 10 seconds |
| NF-02 | Time to first page rendered | < 2 seconds after index ready |
| NF-03 | Page navigation (jump to page N) | < 500ms |
| NF-04 | Thumbnail generation | ≤ 100ms per thumbnail |
| NF-05 | Memory usage (browser tab) | < 500 MB RAM at any time |
| NF-06 | UI frame rate during scroll | 60 fps |

### 7.2 Scalability

| ID | Requirement |
|----|-------------|
| NF-10 | Handle files with up to 10 million pages |
| NF-11 | Virtual-scroll thumbnail strip renders only visible thumbnails |
| NF-12 | Only the current page + ±2 pages are held in render cache |
| NF-13 | Page index stored in IndexedDB for re-opening the same file |

### 7.3 Compatibility

| ID | Requirement |
|----|-------------|
| NF-20 | Support Chrome 120+, Firefox 120+, Safari 17+ |
| NF-21 | Responsive layout: desktop (1440px), tablet (768px) |
| NF-22 | WCAG 2.1 AA accessibility for UI chrome (navigation, controls) |

### 7.4 Reliability

| ID | Requirement |
|----|-------------|
| NF-30 | Gracefully handle corrupted/truncated AFP files |
| NF-31 | Partial render on malformed structured field (skip & continue) |
| NF-32 | Error boundary per page — one bad page does not crash viewer |

---

## 8. Technical Architecture

### 8.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Next.js App)                    │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │   Next.js    │   │  AFP Parser  │   │  Render Engine    │  │
│  │   App Router │   │  (WASM/TS)   │   │  (Canvas / SVG)   │  │
│  │              │   │              │   │                   │  │
│  │  Page UI     │◄──│  Streaming   │──►│  Page Compositor  │  │
│  │  Thumbnail   │   │  Indexer     │   │  Text Renderer    │  │
│  │  Search UI   │   │  Page Parser │   │  Image Decoder    │  │
│  └──────────────┘   └──────────────┘   └───────────────────┘  │
│          │                 │                      │            │
│          ▼                 ▼                      ▼            │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  React State │   │  Web Worker  │   │  OffscreenCanvas  │  │
│  │  (Zustand)   │   │  (parsing)   │   │  (render worker)  │  │
│  └──────────────┘   └──────────────┘   └───────────────────┘  │
│                             │                      │            │
│                    ┌────────┴──────────────────────┘           │
│                    ▼                                            │
│           ┌─────────────────┐                                  │
│           │   IndexedDB     │                                  │
│           │  (Page Index,   │                                  │
│           │   Thumbnails,   │                                  │
│           │   Search Index) │                                  │
│           └─────────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
         │  (for server-side large file support)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Next.js API Routes (Node.js)                   │
│                                                                 │
│   /api/afp/index     — Stream-scan AFP, return page index       │
│   /api/afp/page/[n]  — Return raw bytes for page N             │
│   /api/afp/render/[n]— Server-render page N to PNG (SSR mode)  │
│   /api/afp/search    — Full-text search across index            │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
    File Storage (local filesystem, S3, or user upload)
```

### 8.2 Two Execution Modes

#### Mode A: Client-Side (small/medium files, < 256 MB)
- AFP file loaded via FileReader API into ArrayBuffer
- All parsing done in Web Worker (TypeScript AFP parser)
- Rendering on OffscreenCanvas in separate worker
- Zero server required — pure static Next.js export possible

#### Mode B: Server-Assisted (large files, 256 MB – 2 GB+)
- File stays on server (or cloud storage, S3)
- Next.js API routes handle:
  - **Index scan**: streams file, builds byte-offset page index, returns JSON
  - **Page fetch**: serves raw AFP bytes for a single page via HTTP Range
  - **Render**: optionally server-side renders page to PNG via Node.js canvas
- Client requests only the bytes it needs per page

### 8.3 Thread Architecture

```
Main Thread
 ├── React UI (Next.js App Router)
 ├── Virtual scroll controller
 └── Page cache manager

Web Worker 1: AFP Index Worker
 └── Streams file, emits BPG/EPG events with byte offsets
     Builds: PageIndex[], DocumentIndex[], SearchIndex

Web Worker 2: AFP Page Parser
 └── Given byte range → parses structured fields → emits PageRenderTree

Web Worker 3: Render Worker
 └── Given PageRenderTree → draws to OffscreenCanvas → returns ImageBitmap
```

---

## 9. AFP Parsing Strategy

### 9.1 Two-Pass Architecture

**Pass 1 — Index Scan (streaming, sequential)**

Objective: Build a complete page index without parsing page content.

```typescript
interface PageIndexEntry {
  pageNumber: number;        // 1-based
  documentIndex: number;     // which named group
  documentName: string;      // from BNG
  byteOffset: number;        // file offset of BPG field
  byteLength: number;        // bytes from BPG to EPG (inclusive)
  resourceRefs: string[];    // resource names referenced on this page
}
```

Algorithm:
1. Read file as a ReadableStream (chunked, 64 KB chunks)
2. Maintain a byte-offset counter
3. On each `0x5A` magic byte: read 8-byte header, extract type ID
4. Type dispatch:
   - `D3A8A8` (BDT): record document start offset
   - `D3A8AD` (BPG): push new `PageIndexEntry` with current offset
   - `D3A9AD` (EPG): close current page entry (set length)
   - `D3A6C3` (OBD): record resource reference names
   - Skip all other fields (advance by LENGTH bytes)
5. On complete: return `PageIndexEntry[]` — this is the **Page Index**

This scan is O(N) on file size and requires zero page content parsing. For a 2 GB file it reads every byte once but processes only ~20% of structured fields.

**Pass 2 — Page Parse (on-demand)**

Given `PageIndexEntry.byteOffset` and `byteLength`:
1. Fetch/read only those bytes (HTTP Range or ArrayBuffer slice)
2. Parse ALL structured fields within that range
3. Build a `PageRenderTree`:

```typescript
interface PageRenderTree {
  pageSize: { width: number; height: number };  // in L-units
  resolution: number;                            // L-units per inch
  objects: RenderObject[];
}

type RenderObject =
  | TextObject       // PTOCA text runs
  | ImageObject      // IOCA raster data
  | GraphicsObject   // GOCA commands
  | BarcodeObject    // BCOCA data
  | OverlayRef;      // Overlay include reference
```

### 9.2 Resource Pre-loading

Before rendering a page, resolve all referenced resources:
1. Check inline resource cache (parsed from BDT resource group)
2. If external: request from server resource library endpoint
3. Cache resolved resources in LRU cache (max 200 MB)

### 9.3 EBCDIC Transcoding

AFP text objects frequently use EBCDIC (IBM character encoding). The parser must:
1. Read the active **Coded Font** (from CFI structured field)
2. Identify the associated **Code Page** (from FOCA/CPC structured field)
3. Apply the correct EBCDIC → Unicode mapping table
4. Handle Single-Byte (SBCS) and Double-Byte (DBCS) character sets
5. Ship a compact transcoding table (< 100 KB) covering CP037, CP500, CP1047, CP285 (common production code pages)

### 9.4 Error Handling

- Unknown structured field type: log warning, skip by LENGTH, continue
- LENGTH mismatch or corrupt data: attempt re-sync by scanning for next `0x5A`
- Missing resource: render placeholder (grey box for images, dotted box for overlays)
- Out-of-range coordinates: clamp to page bounds, log warning

---

## 10. Pagination & Large File Strategy

### 10.1 The Core Problem

A 2 GB AFP file with 1 million pages cannot be:
- Loaded into memory (browser RAM limit: ~2 GB)
- Parsed upfront (10M+ structured fields → minutes to parse)
- Rendered to DOM (10M DOM nodes → browser crash)

### 10.2 Three-Layer Strategy

```
Layer 1: FILE ACCESS      — Only read bytes you need (HTTP Range / ArrayBuffer slice)
Layer 2: INDEX            — Lightweight offset map (no page content in memory)
Layer 3: RENDER CACHE     — Keep only N pages rendered (LRU eviction)
```

### 10.3 Page Window Rendering

At any time, maintain a **Page Window** of rendered pages:

```
[page N-2] [page N-1] [PAGE N (current)] [page N+1] [page N+2]
```

- Current page: always rendered at full resolution
- ±2 pages: rendered at full resolution, cached as ImageBitmap
- ±3 to ±10: thumbnails only
- All others: index entry only (byte offsets)

On navigation to page N:
1. Check if `pageCache[N]` exists → display immediately
2. If not: fetch bytes, parse in worker, render in worker, store in cache
3. Pre-fetch N+1, N+2 asynchronously
4. Evict pages outside the window from cache

### 10.4 Thumbnail Generation

Thumbnails are generated as 150×200px `ImageBitmap` at low DPI (36 DPI vs 150 DPI for full render).

Thumbnail strategy:
- Generate on-demand when thumbnail strip scrolls near a page
- Store in IndexedDB (keyed by `${fileHash}:${pageNumber}`)
- Regenerate only if file changes
- Virtual scroll the thumbnail strip: only render thumbnails visible in viewport + buffer of 20

### 10.5 Index Persistence

After first scan of a file:
1. Compute file fingerprint: first 4 KB hash + file size
2. Store `PageIndex[]` in IndexedDB under that key
3. On re-open: detect same file → skip scan, load index instantly

For a 2 GB file, the `PageIndex[]` for 1 million pages (each entry ~100 bytes) = ~100 MB in IndexedDB — feasible.

### 10.6 Progressive Index Display

Do not wait for index scan to complete before showing the UI:
1. Start streaming scan
2. Every 10,000 pages found: emit progress event to UI
3. UI shows "Found 10,000 pages so far… (scanning)"
4. User can navigate to already-indexed pages while scan continues
5. Scan completion unlocks full navigation and search

---

## 11. Rendering Pipeline

### 11.1 Pipeline Overview

```
PageRenderTree
      │
      ▼
 ┌─────────────────────────────────────────────────┐
 │              Page Compositor                     │
 │                                                 │
 │  1. Create OffscreenCanvas(width_px, height_px) │
 │  2. Set white background                        │
 │  3. For each RenderObject (in z-order):         │
 │     ├─ TextObject    → TextRenderer             │
 │     ├─ ImageObject   → ImageDecoder             │
 │     ├─ GraphicsObject→ VectorRenderer           │
 │     └─ BarcodeObject → BarcodeRenderer          │
 │  4. Return ImageBitmap                          │
 └─────────────────────────────────────────────────┘
      │
      ▼
  ImageBitmap → React <canvas> element (main thread)
```

### 11.2 Text Renderer (PTOCA)

```
Input: TextObject { runs: TextRun[], activeFonts: FontMap }

For each TextRun:
  1. Map Local Font ID → Font Resource (FOCA)
  2. Decode text bytes (EBCDIC/Unicode via code page table)
  3. Convert (AMI, AMB) L-unit positions → canvas pixels
  4. Set ctx.font = `${size_pt}pt "${fontFamily}"`
  5. Set ctx.fillStyle = color (from SEC control sequence)
  6. ctx.fillText(text, x_px, y_px)
```

Font mapping strategy:
- Use AFP font names to map to web-safe fallback fonts
- Download embedded FOCA font data if TrueType/OpenType is embedded
- AFP raster fonts (character set bitmaps): render character by character from bitmap

### 11.3 Image Renderer (IOCA)

Supported compression formats (IOCA):
| Format | Description | Browser Support |
|--------|-------------|----------------|
| Uncompressed | Raw bitmap | Native decode |
| JPEG | ISO 10918 | Native (`createImageBitmap`) |
| CCITT Fax Group 3 | 1D TIFF-style | JavaScript decode |
| CCITT Fax Group 4 | 2D (most common in AFP) | JavaScript decode |
| IBM MMR | Modified Modified READ | JavaScript decode |
| G4 (JBIG2-like) | IBM proprietary | JavaScript decode |

For CCITT G4 (the most common AFP image format), implement a pure TypeScript CCITT G4 decoder or use a WebAssembly port.

### 11.4 Graphics Renderer (GOCA)

Map GOCA drawing commands to Canvas 2D API:

| GOCA Command | Canvas Equivalent |
|---|---|
| GBLINE (line) | `ctx.lineTo` |
| GBARC (arc) | `ctx.arc` |
| GBFILLET (Bezier) | `ctx.bezierCurveTo` |
| GBBOX (rectangle) | `ctx.rect` |
| GBIMG (filled area) | `ctx.fill` |
| GSCOL (set color) | `ctx.strokeStyle` / `ctx.fillStyle` |
| GSLW (line width) | `ctx.lineWidth` |

### 11.5 Canvas Resolution & Zoom

```typescript
const PAGE_DPI = 150;    // base render DPI
const LUNIT_PER_INCH = 1440;

function lunitToPixel(lunit: number, zoom: number): number {
  return (lunit / LUNIT_PER_INCH) * PAGE_DPI * zoom;
}
```

- Default zoom = 1.0 (fits page width to viewport)
- Zoom range: 0.25 to 4.0
- On zoom change: re-render current page at new DPI
- Use CSS `transform: scale()` for intermediate zoom (no re-render until zoom settles)

---

## 12. UI/UX Requirements

### 12.1 Layout

```
┌────────────────────────────────────────────────────────────────────┐
│  [☰ Menu]  AFP Viewer  [🔍 Search]  [📥 Upload]   Page: [___] / N  │  ← Header
├───────────────┬────────────────────────────────────────────────────┤
│               │                                                    │
│  Thumbnail    │                                                    │
│  Strip        │                  Page Canvas                      │
│               │                                                    │
│  [page 1]     │          ┌──────────────────────────┐             │
│  [page 2]     │          │                          │             │
│  [page 3]     │          │    Rendered AFP Page     │             │
│  [page 4]     │          │                          │             │
│  [page 5]     │          └──────────────────────────┘             │
│     ...       │                                                    │
│  (virtual     │                                                    │
│   scrolled)   │                                                    │
│               │                                                    │
├───────────────┴────────────────────────────────────────────────────┤
│  [◀ Prev]  Page 42 of 1,000,000  [Next ▶]  [🔍 -] 100% [🔍 +]    │  ← Footer
└────────────────────────────────────────────────────────────────────┘
```

### 12.2 Key Interactions

| Action | Method |
|--------|--------|
| Next page | Right arrow / `]` / click Next |
| Previous page | Left arrow / `[` / click Prev |
| Jump to page | Type page number in header input + Enter |
| Zoom in/out | Ctrl+= / Ctrl+- / mouse wheel + Ctrl |
| Fit to width | `W` key or toolbar button |
| Fit to page | `P` key or toolbar button |
| Search | Ctrl+F opens search panel |
| Upload file | Drag anywhere on screen or click Upload |
| Toggle thumbnails | `T` key or sidebar toggle button |

### 12.3 Loading States

- **File indexing**: Progress bar with "Indexing page N of ~M estimated…"
- **Page loading**: Skeleton shimmer on page canvas area
- **Thumbnail**: Lazy-loaded placeholder until bitmap ready
- **Search indexing**: Status indicator in search panel

### 12.4 Error States

- **Unsupported field**: Yellow warning banner (dismissible), rendering continues
- **Missing resource**: Page renders with placeholder, warning icon in status bar
- **Corrupt file**: Error page with details and option to try recovery mode
- **Out of memory**: Prompt to enable server-assisted mode

---

## 13. API Design

### 13.1 Server-Side AFP API Routes

#### `POST /api/afp/upload`
Upload AFP file, returns file handle ID for subsequent API calls.

```typescript
// Response
{
  fileId: string;
  size: number;
  estimatedPages: number;   // rough estimate from file size
}
```

#### `GET /api/afp/[fileId]/index`
Stream the page index scan. Returns Server-Sent Events (SSE) as pages are found.

```
data: {"type":"progress","pagesFound":10000,"bytesScanned":52428800}
data: {"type":"page","index":{"pageNumber":1,"byteOffset":1024,"byteLength":4096,...}}
...
data: {"type":"complete","totalPages":1000000}
```

#### `GET /api/afp/[fileId]/page/[pageNum]`
Returns raw AFP bytes for page N.

```
Content-Type: application/octet-stream
Content-Length: <bytes>
```

#### `GET /api/afp/[fileId]/render/[pageNum]?dpi=150&format=png`
Server-side render page to PNG. Used as fallback or for thumbnails.

```
Content-Type: image/png
```

#### `GET /api/afp/[fileId]/search?q=<query>&maxResults=100`
Full-text search across pre-built text index.

```typescript
{
  results: Array<{
    pageNumber: number;
    excerpt: string;
    matchStart: number;
    matchLength: number;
  }>;
  totalMatches: number;
}
```

#### `GET /api/afp/[fileId]/export/pdf?pages=1-10,42,100-200`
Export page range as PDF.

---

## 14. Technology Stack

### 14.1 Frontend

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | **Next.js 15** (App Router) | Streaming SSR, server components, API routes |
| Language | **TypeScript 5** | Type safety for complex AFP data models |
| State | **Zustand** | Lightweight, no boilerplate, works with workers |
| UI Components | **shadcn/ui** + Tailwind CSS | Fast, accessible, composable |
| Canvas | **Canvas 2D API** + **OffscreenCanvas** | Off-main-thread rendering |
| Virtual Scroll | **TanStack Virtual** | Handles millions of items efficiently |
| Worker Comm | **Comlink** (wraps Web Workers in async API) | Clean worker/main-thread interface |
| Animations | **Framer Motion** (minimal) | Page transitions, skeleton loaders |

### 14.2 AFP Parser

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Core Parser | **TypeScript** (pure TS, no deps) | Browser + Node.js compatible |
| CCITT G4 Decoder | **TypeScript** or **Rust/WASM** | Pure TS for portability; WASM for perf |
| EBCDIC Tables | JSON lookup tables (gzip compressed) | Sub-100 KB bundle |
| Binary reading | **DataView** API | Efficient big-endian binary reads |

### 14.3 Backend

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | **Next.js API Routes** (Node.js) | Co-located with frontend |
| File Streaming | Node.js `fs.createReadStream` + range-aware | Memory-efficient for 2 GB files |
| Search Index | **Orama** (in-memory) or file-backed | Fast full-text, embedded, no DB needed |
| Server Render | **node-canvas** (Cairo-backed) | Headless canvas for server-side page render |
| Caching | **LRU cache** in memory | Per-file page index caching |
| File Storage | Local FS or **S3/compatible** via signed URL | Pluggable storage adapters |

### 14.4 Build & Tooling

| Tool | Use |
|------|-----|
| **Turbopack** (Next.js 15) | Fast dev builds |
| **Vitest** | Unit + integration tests |
| **Playwright** | E2E visual regression tests |
| **ESLint** + **Prettier** | Code quality |
| **Docker** | Containerized deployment |

---

## 15. Data Models

### 15.1 Core Types

```typescript
// Page Index Entry — lightweight, millions of these
interface PageIndexEntry {
  pageNumber: number;          // 1-based page number
  documentIndex: number;       // which BNG/ENG group
  documentName: string | null; // BNG name attribute
  byteOffset: number;          // byte offset of BPG in file
  byteLength: number;          // bytes from BPG to EPG inclusive
  resourceRefs: string[];      // resource names referenced
  hasText: boolean;            // quick flag for search indexing
  hasImages: boolean;
}

// Parsed page ready for rendering
interface PageRenderTree {
  pageNumber: number;
  width: number;       // L-units
  height: number;      // L-units
  resolution: number;  // L-units per inch (typically 1440)
  objects: RenderObject[];
  resources: ResolvedResources;
}

type RenderObject =
  | { type: 'text';     data: PTOCATextObject }
  | { type: 'image';    data: IOCAImageObject }
  | { type: 'graphics'; data: GOCAObject }
  | { type: 'barcode';  data: BCOCAObject }
  | { type: 'overlay';  data: OverlayInclude };

interface PTOCATextObject {
  x: number; y: number;       // L-units
  runs: TextRun[];
  orientation: 0 | 90 | 180 | 270;
}

interface TextRun {
  text: string;                // UTF-8 after EBCDIC decode
  fontId: string;              // resolved font family name
  fontSize: number;            // in points
  color: RGBA;
  dx: number; dy: number;      // delta from previous run origin
}

interface IOCAImageObject {
  x: number; y: number;        // L-units
  width: number; height: number;
  compression: 'none' | 'jpeg' | 'ccitt-g3' | 'ccitt-g4' | 'mmr';
  data: Uint8Array;
  bitDepth: 1 | 8 | 24;
}

// App viewer state
interface ViewerState {
  file: File | null;
  fileId: string | null;
  totalPages: number;
  indexedPages: number;        // during progressive scan
  indexing: boolean;
  currentPage: number;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  searchQuery: string;
  searchResults: SearchResult[];
  pageCache: Map<number, ImageBitmap>;
  thumbnailCache: Map<number, ImageBitmap>;
}
```

---

## 16. Security Requirements

| ID | Requirement |
|----|-------------|
| S-01 | Validate AFP file magic byte (`0x5A`) before processing |
| S-02 | Enforce max upload file size (configurable, default 2 GB) |
| S-03 | Sanitize all file path inputs to prevent directory traversal |
| S-04 | AFP parsing runs in isolated Web Worker (renderer process sandbox) |
| S-05 | Server: stream files without loading full content to RAM |
| S-06 | Signed URLs for remote file access (no direct filesystem exposure) |
| S-07 | Content Security Policy: block inline scripts, limit canvas sources |
| S-08 | Rate limit `/api/afp/upload` and `/api/afp/render` endpoints |
| S-09 | No SSRF: validate URLs before fetching remote AFP files |
| S-10 | AFP structured field LENGTH must be validated (prevent buffer overread) |

---

## 17. Performance Targets

### 17.1 File Operations

| Operation | File Size | Target |
|-----------|-----------|--------|
| Index scan start (TTFP — time to first page) | Any | < 500ms |
| Complete index scan | 100 MB | < 2s |
| Complete index scan | 1 GB | < 15s |
| Complete index scan | 2 GB | < 30s |
| Page parse + render | Any | < 200ms |
| Jump to arbitrary page | Any (indexed) | < 500ms |
| Thumbnail generation | Any | < 100ms per thumb |

### 17.2 Rendering Quality

| Metric | Target |
|--------|--------|
| Text fidelity | Correct position ± 1px at 150 DPI |
| Image fidelity | Pixel-perfect for CCITT G4, JPEG |
| Color fidelity | sRGB output matching AFP color spec |

### 17.3 Memory Budget

| Component | Budget |
|-----------|--------|
| Page index (1M pages) | ~100 MB (IndexedDB) |
| Active render cache (5 pages × ~2 MB) | ~10 MB |
| Thumbnail cache (100 thumbs × 40 KB) | ~4 MB |
| AFP Parser + workers | ~50 MB |
| React UI | ~30 MB |
| **Total (browser heap)** | **< 200 MB typical, < 500 MB peak** |

---

## 18. Milestones & Roadmap

### Phase 1: Foundation (Weeks 1-4)
- [ ] Project scaffold: Next.js 15, TypeScript, Tailwind, shadcn/ui
- [ ] AFP binary parser (TypeScript): structured field reader, type dispatch
- [ ] Index scan: BPG/EPG detection, `PageIndexEntry` building
- [ ] Page renderer: PTOCA text (basic, ASCII/Latin-1 only)
- [ ] Basic UI: file upload, page display, prev/next navigation
- [ ] Unit tests: parser correctness on sample AFP files

### Phase 2: Core Rendering (Weeks 5-8)
- [ ] EBCDIC transcoding (CP037, CP500, CP1047)
- [ ] IOCA image decoding: JPEG, CCITT G4
- [ ] GOCA vector graphics rendering
- [ ] BCOCA bar code rendering (common symbologies)
- [ ] Resource resolution: inline resources
- [ ] Zoom and fit-to-page/width
- [ ] Thumbnail generation & virtual thumbnail strip

### Phase 3: Large File Performance (Weeks 9-12)
- [ ] Web Worker architecture (index worker, parse worker, render worker)
- [ ] OffscreenCanvas rendering pipeline
- [ ] HTTP Range request support for server-hosted files
- [ ] Next.js API routes: `/api/afp/*`
- [ ] Progressive index with SSE streaming
- [ ] IndexedDB persistence (page index, thumbnails)
- [ ] Page window pre-fetch (±2 pages)
- [ ] Performance profiling: hit 2 GB / 1M page targets

### Phase 4: Search & Export (Weeks 13-16)
- [ ] Text extraction from PTOCA → full-text index
- [ ] Search UI with highlights and result navigation
- [ ] Page export: PNG
- [ ] Page range export: PDF (via pdf-lib)
- [ ] Document tree navigator (multi-document AFP)

### Phase 5: Polish & Production (Weeks 17-20)
- [ ] WCAG 2.1 AA accessibility audit & fixes
- [ ] Error boundary hardening, corrupt file recovery
- [ ] Structured field inspector (developer mode)
- [ ] Docker deployment config
- [ ] E2E tests (Playwright)
- [ ] Performance regression tests

---

## 19. Open Questions

| # | Question | Owner | Resolution |
|---|----------|-------|------------|
| OQ-1 | Should the parser support external AFP resource libraries (e.g., serve from a configured directory)? | Product | Decision needed before Phase 2 |
| OQ-2 | Do we need server-side rendering as primary mode (for low-power clients)? | Eng | Evaluate during Phase 3 perf testing |
| OQ-3 | Which EBCDIC code pages are most common in target customer files? | Product | Survey existing users |
| OQ-4 | Should search index be built server-side (for large files)? | Eng | Depends on server mode vs. client mode |
| OQ-5 | License model: open source (MIT) or commercial? | Business | TBD |
| OQ-6 | How to handle AFP files with print-only resources on mainframe (no inline resources)? | Product | Design resource library upload/mapping UI |
| OQ-7 | Should we support AFP/A (archival compliance) markers? | Product | Likely yes for financial sector clients |

---

## 20. Appendix: AFP Reference Summary

### Key Structured Field Type IDs

| Hex ID | Abbreviation | Description |
|--------|-------------|-------------|
| D3A8A8 | BDT | Begin Document |
| D3A9A8 | EDT | End Document |
| D3A87B | BPT | Begin Presentation Text (PTOCA) |
| D3A97B | EPT | End Presentation Text |
| D3EEEE | PTD | Presentation Text Descriptor |
| D3EE6B | PTX | Presentation Text Data |
| D3A8AD | BPG | Begin Page |
| D3A9AD | EPG | End Page |
| D3A8C5 | BIM | Begin Image (IOCA) |
| D3A9C5 | EIM | End Image |
| D3ACCE | IDD | Image Data Descriptor |
| D3EEcE | IDE | Image Data Element |
| D3A8C3 | BGR | Begin Graphics (GOCA) |
| D3A9C3 | EGR | End Graphics |
| D3EECC | GAD | Graphics Area Data |
| D3A8EB | BBC | Begin Bar Code (BCOCA) |
| D3A9EB | EBC | End Bar Code |
| D3A6C3 | OBD | Object Area Descriptor |
| D3AC6B | OBP | Object Area Position |
| D3A87E | BFG | Begin Font Resource Group |
| D3A6EE | FNC | Font Control |
| D3ABCA | BNG | Begin Named Group |
| D3A9CA | ENG | End Named Group |
| D3ABAF | BRS | Begin Resource |
| D3A9AF | ERS | End Resource |
| D3A8A7 | BAG | Begin Object Area (page group) |
| D3A9A7 | EAG | End Object Area |

### Common AFP Code Pages for EBCDIC Transcoding

| Code Page | IBM Name | Territory |
|-----------|----------|-----------|
| CP037 | EBCDIC-US | USA/Canada |
| CP500 | EBCDIC-INT | International |
| CP1047 | EBCDIC-Open Systems | Linux/UNIX |
| CP273 | EBCDIC-DE | Germany/Austria |
| CP285 | EBCDIC-UK | United Kingdom |
| CP297 | EBCDIC-FR | France |
| CP930 | EBCDIC-JP | Japan (mixed SBCS/DBCS) |

### Official Specifications Reference

All specifications are published by the AFP Consortium (https://afpcinc.org/publications/):

| Spec | Version | Description |
|------|---------|-------------|
| MO:DCA | AFPC-0004-10 | The container format — foundational |
| PTOCA | AFPC-0009-04 | Text rendering (Feb 2025) |
| IOCA | AFPC-0003-09 | Images (2024) |
| GOCA | AFPC-0008-03 | Vector graphics |
| BCOCA | AFPC-0005-11 | Bar codes (Dec 2025) |
| FOCA | AFPC-0007-06 | Fonts |
| CMOCA | AFPC-0006-02 | Color management (Jun 2025) |
| MOCA | AFPC-0013-02 | Metadata (Mar 2025) |
| Line Data | APFC-0010-05 | Line data format |
| IPDS | AFPC-0001-12 | Intelligent Printer Data Stream |

> Download these manually from https://afpcinc.org/publications/ — direct PDF downloads are restricted by the consortium website.

---

*Document prepared: 2026-03-31. All AFP specifications referenced are the latest published versions as of that date.*
