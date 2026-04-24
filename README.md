<p align="center">
  <h1 align="center">AFP Viewer</h1>
  <p align="center">
    A high-performance, browser-based viewer for IBM AFP documents.
    <br />
    Open, view, search, and export AFP files — no plugins, no installs, just your browser.
    <br />
    <br />
    <a href="#quick-start">Quick Start</a>
    &middot;
    <a href="#features">Features</a>
    &middot;
    <a href="#api-reference">API</a>
    &middot;
    <a href="#contributing">Contributing</a>
  </p>
</p>

<br />

## Why AFP Viewer?

IBM AFP files power millions of documents in banking, insurance, government, and telecom — yet there's no lightweight, modern way to view them. Traditional AFP viewers require expensive IBM software, desktop installs, or legacy Java applets.

**AFP Viewer** changes that. Drop an AFP file into your browser and see it rendered — text, images, vector graphics, barcodes, and all. Files up to **2 GB** with millions of pages work out of the box.

<br />

## Quick Start

```bash
git clone https://github.com/user/afp-viewer.git
cd afp-viewer
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drag in an `.afp` file, and you're viewing.

<br />

## Features

### Full AFP Format Support

| Component | What It Renders |
|-----------|----------------|
| **PTOCA** | Presentation text — positioned text runs, EBCDIC decoding, font/weight mapping, color |
| **IOCA** | Raster images — CCITT Group 4 fax, JPEG, uncompressed (bi-level, grayscale, RGB, CMYK, YCbCr) |
| **GOCA** | Vector graphics — lines, arcs, boxes, bezier curves, filled areas, colors, patterns |
| **BCOCA** | Barcodes — Code 39, Code 128, EAN-13, UPC-A, Interleaved 2-of-5, QR Code, DataMatrix |
| **EBCDIC** | Code page transcoding — CP037, CP500, CP1047, and extensible registry |

### Document Viewing

- Handles files from kilobytes up to **2 GB**
- Two-pass parsing: fast index scan, then on-demand page rendering
- Jump to any page instantly via page number input
- Virtual-scrolled thumbnail sidebar for visual navigation
- Keyboard shortcuts for power users

### View Controls

- **Zoom** from 10 % to 500 % with smooth scaling and presets
- **Fit-to-width** and **fit-to-page** modes
- **Rotation** in 90-degree increments
- **Element inspector** — crosshair tool that hit-tests text, images, graphics, and barcodes with tooltips showing coordinates, font info, and copyable text
- Collapsible thumbnail sidebar with document grouping

### Search

- Full-text search across all pages (powered by [Orama](https://orama.com))
- Filter by type: All, Text only, TLE only
- Search result highlighting on the rendered canvas (yellow = match, orange = active)
- Navigate between matches with Enter / Shift+Enter
- Background index building with progress indicator

### Export

- **PDF** — Multi-page PDF at configurable DPI (96 / 150 / 300)
- **HTML** — Self-contained HTML5 with embedded graphics
- **JSON** — Structured metadata + base64-encoded page renders

### Document Splitting

- **Split at page** — cut the document at any page into two valid AFP files
- **Batch split** — split every N pages into multiple parts, downloaded as a ZIP archive
- Each output file is a structurally complete AFP document (preamble with all resources, fonts, overlays, and medium maps is included in every part)
- Browser-side splitting uses the pre-built page index — no re-scanning, instant even for large files
- **Python CLI** (`scripts/afp_cut.py`) for server-side batch processing with mmap (136 MB split in ~300 ms)

### Element Tree

- Hierarchical view of every AFP structured field — 170+ types recognized
- **Progressive loading** — first 50,000 elements load instantly, the rest stream in the background without blocking the UI
- **Virtualized scrolling** (TanStack Virtual) — stays fast regardless of tree size
- Real-time search across element names, type IDs, and data previews
- Element detail panel: type ID, byte offset, decoded data, image/PDF preview, text content extraction
- Inline editing of TLE values and NOP text (EBCDIC round-trip)
- Context-menu export of any element subtree as a standalone AFP file
- Resizable panel, auto-expand to selected page or search match

### Document Info & Diagnostics

- **Document Info** — file metadata, TLE key/value pairs, NOP comments
- **Font inventory** — code pages (CP297 French, CP500 International, etc.), character sets with type, weight, and family
- **Document divider** — select a TLE key to group pages into logical sub-documents with visual grouping in the thumbnail strip
- **Diagnostics panel** — 50+ checks: structure validation, resource integrity, corruption detection, compatibility warnings, severity filtering

### Two Execution Modes

| Mode | File Size | How It Works |
|------|-----------|-------------|
| **Client-side** | < 256 MB | File loaded entirely in browser, parsed in main thread |
| **Server-assisted** | 256 MB – 2 GB+ | File stays on server, pages served on demand via API |

<br />

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Next page | `Right Arrow` or `]` |
| Previous page | `Left Arrow` or `[` |
| Zoom in | `Ctrl + =` |
| Zoom out | `Ctrl + -` |
| Fit to width | `W` |
| Fit to page | `P` |
| Toggle thumbnails | `T` |
| Open search | `Ctrl + F` |
| Close panel | `Escape` |

<br />

## Architecture

```
AFP File (binary)
     │
     ▼
┌──────────────────┐
│  Pass 1: Index   │  Reads only structured field headers (0x5A + LENGTH + TYPE_ID)
│  Scan            │  Builds page offset index — O(N) on file size, skips content
└────────┬─────────┘
         ▼
┌──────────────────┐
│  Pass 2: Page    │  Given byte range for one page, parses all structured fields
│  Parse           │  Builds PageRenderTree with text / image / graphics / barcode objects
└────────┬─────────┘
         ▼
┌──────────────────┐
│  Compositor      │  Dispatches to PTOCA, IOCA, GOCA, BCOCA renderers
└────────┬─────────┘
         ▼
┌──────────────────┐
│  Canvas Output   │  HTMLCanvasElement with the fully rendered page
└──────────────────┘
```

**Page Window Strategy:** Only the current page ±2 are fully rendered (LRU cache). Pages ±3–10 have thumbnails only. Everything else is an index entry. This keeps browser memory under **500 MB** even for million-page files.

<br />

## API Reference

The server-assisted mode exposes these endpoints for large-file processing:

### Upload

```
POST /api/afp/upload
Content-Type: multipart/form-data
```

```json
{
  "fileId": "uuid-string",
  "size": 1048576,
  "fileName": "document.afp",
  "estimatedPages": 512
}
```

### Index Scan (SSE)

```
GET /api/afp/{fileId}/index
```

Streams page index via Server-Sent Events:

```
data: {"type":"progress","pagesFound":10000,"bytesScanned":52428800}
data: {"type":"page","pageNumber":1,"byteOffset":1024,"byteLength":4096}
data: {"type":"complete","totalPages":1000000}
```

### Fetch Page

```
GET /api/afp/{fileId}/page/{pageNum}
→ application/octet-stream
```

### Search

```
GET /api/afp/{fileId}/search?q={query}&maxResults=100
```

```json
{
  "query": "search term",
  "results": [
    { "pageNumber": 42, "excerpt": "...matching text...", "matchOffset": 15, "matchLength": 11 }
  ],
  "totalMatches": 1
}
```

### Export (PDF)

```
GET /api/afp/{fileId}/export/pdf?pages=1-10,42
→ application/pdf
```

<br />

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 15](https://nextjs.org) (App Router) |
| Language | TypeScript 5 |
| State | [Zustand](https://zustand-demo.pmnd.rs/) |
| UI | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4 |
| Rendering | Canvas 2D API |
| Virtual Scroll | [TanStack Virtual](https://tanstack.com/virtual) |
| Search Index | [Orama](https://orama.com) (in-memory full-text) |
| ZIP | [fflate](https://github.com/101arrowz/fflate) (batch split export) |
| PDF Export | [pdf-lib](https://pdf-lib.js.org/) |
| Icons | [Lucide](https://lucide.dev/) |
| Binary Parsing | DataView API (big-endian) |

<br />

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    Main page
│   ├── layout.tsx                  Root layout
│   ├── globals.css                 Tailwind + theme
│   └── api/afp/                    Server API routes
│       ├── upload/route.ts
│       └── [fileId]/
│           ├── index/route.ts      SSE index scanning
│           ├── page/[pageNum]/     Raw page bytes
│           ├── render/[pageNum]/   Server-side render
│           ├── search/route.ts     Full-text search
│           └── export/pdf/         PDF export
├── lib/
│   ├── afp/                        Core AFP parser
│   │   ├── parser.ts               Structured field parser
│   │   ├── index-scanner.ts        Pass 1 index scan
│   │   ├── page-parser.ts          Pass 2 page parse
│   │   ├── afp-cutter.ts           Document split/batch split + ZIP
│   │   ├── types.ts                Type definitions
│   │   └── constants.ts            AFP type IDs
│   ├── ptoca/                      Text rendering
│   ├── ioca/                       Image decoding
│   ├── goca/                       Vector graphics
│   ├── bcoca/                      Barcode rendering
│   ├── ebcdic/                     EBCDIC transcoding
│   ├── export/                     PDF / HTML / JSON export
│   ├── search/                     Full-text search index
│   └── renderer/
│       └── compositor.ts           Page compositor
├── components/
│   ├── ui/                         shadcn/ui primitives
│   └── viewer/
│       ├── AfpViewer.tsx           Main viewer shell
│       ├── PageCanvas.tsx          Canvas renderer
│       ├── ThumbnailStrip.tsx      Thumbnail sidebar
│       ├── ElementTree.tsx         AFP structure inspector
│       ├── DocumentInfo.tsx        Document metadata
│       ├── DiagnosticsPanel.tsx    Parsing diagnostics
│       ├── SearchPanel.tsx         Search overlay
│       ├── ExportDialog.tsx        Export dialog
│       ├── SplitDialog.tsx        Document splitting modal
│       ├── Header.tsx              Top toolbar
│       ├── Footer.tsx              Bottom toolbar
│       ├── FileUpload.tsx          Drag-and-drop upload
│       └── LoadingOverlay.tsx      Index progress
├── store/
│   └── afpViewerStore.ts           Zustand store
├── hooks/
│   └── useAfpViewer.ts             Main viewer hook
scripts/
└── afp_cut.py                      Python CLI for AFP splitting (mmap-based)
```

<br />

## Scripts

```bash
npm run dev        # Start dev server (Turbopack)
npm run build      # Production build
npm run start      # Start production server
npm run lint       # ESLint
npm test           # Run tests (Vitest)
npm run test:watch # Tests in watch mode
```

### Python CLI — AFP Splitter

Standalone tool for splitting AFP files without the web UI. Requires Python 3.8+. Uses mmap — handles multi-GB files in milliseconds.

```bash
# Split after page 50 into two files
python3 scripts/afp_cut.py input.afp 50

# Batch split every 200 pages
python3 scripts/afp_cut.py input.afp 200 --every

# Custom output prefix
python3 scripts/afp_cut.py input.afp 100 --every -o /tmp/output_prefix
```

<br />

## Performance

| Metric | Target |
|--------|--------|
| Index scan (2 GB file) | < 30 seconds |
| Time to first page | < 2 seconds after index |
| Page jump navigation | < 500 ms |
| Thumbnail generation | < 100 ms per thumbnail |
| Browser memory ceiling | < 500 MB |

<br />

## Browser Support

| Browser | Minimum Version |
|---------|----------------|
| Chrome | 120+ |
| Firefox | 120+ |
| Safari | 17+ |
| Edge | 120+ |

Responsive layout: desktop (1440px+) and tablet (768px+).

<br />

## AFP Resources

For anyone working with AFP format:

- [AFP Consortium](https://afpcinc.org) — Official specifications
- **MO:DCA** (AFPC-0004-10) — Container format
- **PTOCA** (AFPC-0009-04) — Presentation text
- **IOCA** (AFPC-0003-09) — Images
- **GOCA** (AFPC-0008-03) — Vector graphics
- **BCOCA** (AFPC-0005-11) — Bar codes
- **FOCA** (AFPC-0007-06) — Fonts

<br />

## Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please make sure your code passes `npm run lint` and `npm test` before submitting.

<br />

## Support the Project

If you find AFP Viewer useful, consider buying me a coffee:

<a href="https://buymeacoffee.com/sergejk" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48"></a>

<br />

## License

MIT License — see [LICENSE](LICENSE) for details.
