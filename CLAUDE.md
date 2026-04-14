# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AFP Viewer is a high-performance, browser-based web application for viewing IBM AFP (Advanced Function Presentation) documents. It handles files up to 2 GB with millions of pages, supporting text (PTOCA), images (IOCA), graphics (GOCA), barcodes (BCOCA), and fonts (FOCA).

**Status:** Active development — full viewer implemented with text, image, tree, search, diagnostics.

## AFP Element Database Rule

**IMPORTANT:** When investigating, debugging, or implementing ANY AFP structured field element:
1. **Always consult** `docs/AFP-ELEMENT-DATABASE.md` first for known type IDs, formats, and parsing rules
2. **Always update** the database when discovering new elements, formats, or parsing behaviors
3. **Save all findings** — byte layouts, SDF formats, polarity rules, encoding patterns
4. **Reference the database** in code comments when implementing parsers
5. The database is the single source of truth for AFP binary format knowledge in this project

## Technology Stack

- **Framework:** Next.js 15 (App Router) with TypeScript 5
- **State:** Zustand
- **UI:** shadcn/ui + Tailwind CSS
- **Rendering:** Canvas 2D API + OffscreenCanvas (off-main-thread)
- **Virtual Scroll:** TanStack Virtual
- **Worker Communication:** Comlink
- **AFP Parser:** Pure TypeScript, browser + Node.js compatible
- **Binary Reads:** DataView API (big-endian)
- **CCITT G4 Decoder:** TypeScript or Rust/WASM
- **EBCDIC Tables:** JSON lookup tables (<100 KB compressed)
- **Server:** Next.js API Routes (Node.js)
- **Search Index:** Orama (in-memory full-text)
- **Server Render:** node-canvas (Cairo)

## Architecture

### Two Execution Modes

- **Client-side** (files < 256 MB): FileReader API → ArrayBuffer → Web Worker parsing → OffscreenCanvas rendering
- **Server-assisted** (256 MB – 2 GB+): File stays on server, Next.js API routes serve page index + byte ranges on demand

### Thread Model

- **Main thread:** React UI, virtual scroll controller, page cache manager
- **Worker 1 (Index):** Streams file, emits BPG/EPG events with byte offsets, builds PageIndex[]
- **Worker 2 (Page Parser):** Given byte range → parses structured fields → emits PageRenderTree
- **Worker 3 (Render):** Given PageRenderTree → draws to OffscreenCanvas → returns ImageBitmap

### Two-Pass Parsing

1. **Pass 1 — Index Scan:** Streaming O(N) scan, reads only structured field headers (0x5A magic byte → 2-byte length → 3-byte type ID), builds page offset index without parsing content
2. **Pass 2 — On-demand Page Parse:** Fetches only the byte range for a single page, parses all structured fields within, builds PageRenderTree for rendering

### Page Window Strategy

Only current page ±2 are fully rendered (LRU cache). Pages ±3–10 have thumbnails only. Everything else is just an index entry (byte offsets). IndexedDB stores page index and thumbnails for re-open.

## AFP Binary Format

Every AFP record: `[0x5A] [LENGTH: 2B big-endian] [TYPE_ID: 3B] [FLAGS: 1B] [SEQ: 2B] [DATA: variable]`

Key type codes (hex):
- `D3A8A8`/`D3A9A8` — BDT/EDT (Begin/End Document)
- `D3A8AD`/`D3A9AD` — BPG/EPG (Begin/End Page)
- `D3A87B` — BPT (Begin Presentation Text)
- `D3A8C5` — BIM (Begin Image)
- `D3A8C3` — BGR (Begin Graphics)
- `D3A8EB` — BBC (Begin Bar Code)

Coordinates use L-units (typically 1440 per inch), origin top-left. Conversion: `pixels = (l_units / 1440) * DPI * zoom`

## API Routes

- `POST /api/afp/upload` — Upload file, returns fileId
- `GET /api/afp/[fileId]/index` — SSE stream of page index scan progress
- `GET /api/afp/[fileId]/page/[pageNum]` — Raw AFP bytes for one page
- `GET /api/afp/[fileId]/render/[pageNum]?dpi=150&format=png` — Server-side rendered PNG
- `GET /api/afp/[fileId]/search?q=<query>` — Full-text search
- `GET /api/afp/[fileId]/export/pdf?pages=1-10,42` — PDF export

## Key Documents

- `PRD/PRD.md` — Full product requirements document
- `docs/specs/AFP-SPECIFICATIONS-INDEX.md` — AFP Consortium specification URLs and binary format reference
- `AFP-Files/` — Sample AFP files for testing

## Performance Targets

- Index scan for 2 GB file: < 10 seconds
- Time to first page rendered: < 2 seconds after index ready
- Page navigation (jump to page N): < 500ms
- Browser memory: < 500 MB at any time
- Thumbnail generation: ≤ 100ms per thumbnail
