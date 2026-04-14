# AFP Element Database

Comprehensive reference of all AFP structured field types, their binary formats, and implementation notes.
Updated as new elements are discovered during development.

---

## Structured Field Format

Every AFP record: `[0x5A] [LENGTH:2B BE] [TYPE_ID:3B] [FLAGS:1B] [SEQ:2B] [DATA:variable]`

- LENGTH includes itself (2 bytes) + TYPE_ID (3) + FLAGS (1) + SEQ (2) + DATA
- DATA length = LENGTH - 8

---

## Document Structure Fields

| Type ID | Abbrev | Full Name | Class | Description |
|---------|--------|-----------|-------|-------------|
| D3A8A5 | BPF | Begin Print File | Begin | Top-level container for older AFP format |
| D3A9A5 | EPF | End Print File | End | |
| D3A8A8 | BDT | Begin Document | Begin | Document boundary |
| D3A9A8 | EDT | End Document | End | |
| D3A8AD | BPG | Begin Page | Begin | Standard page boundary |
| D3A9AD | EPG | End Page | End | |
| D3A8AF | BRS | Begin Resource | Begin | Resource/page container (also used as page boundary) |
| D3A9AF | ERS | End Resource | End | |
| D3ABCA | BNG | Begin Named Group | Begin | Named document group |
| D3A9CA | ENG | End Named Group | End | |

## Environment Group Fields

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8C9 | BAG | Begin Active Env Group | Contains MCF, PGD, PTP |
| D3A9C9 | EAG | End Active Env Group | |
| D3A8C6 | BOG | Begin Object Env Group | Resource group container |
| D3A9C6 | EOG | End Object Env Group | |
| D3A8C7 | BDG | Begin Doc Env Group | Document-level environment |
| D3A9C7 | EDG | End Doc Env Group | |

## Page Descriptor & Position

| Type ID | Abbrev | Full Name | Format |
|---------|--------|-----------|--------|
| D3A6AF | PGD | Page Descriptor | `[flags:2][xRes:2][yRes:2][width:3 BE][height:3 BE][rest]` — Resolution in units per 10 inches. Width/height in L-units. |
| D3B19B | PTP | Pres Text Position | Page text area position |
| D3AC6B | OBP | Object Area Position | Object placement on page |
| D3A66B | OAD | Object Area Descriptor | Contains triplets: 0x43 (unit base), 0x4B (size), 0x4C (extent), 0x49 (pres space) |
| D3A6C3 | OAD2 | Object Area Descriptor | Legacy variant |

## Presentation Text (PTOCA)

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A87B | BPT | Begin Pres Text | Standard PTOCA text block |
| D3A97B | EPT | End Pres Text | |
| D3A89B | BPT | Begin Pres Text (alt) | Alternate type code (same function) |
| D3A99B | EPT | End Pres Text (alt) | |
| D3EE9B | PTX | Pres Text Data | Contains PTOCA control sequences + text |
| D3EE6B | PTX | Pres Text Data (std) | Standard PTX type code |
| D3EEEE | NOP | No Operation | Contains metadata comments (key,value format) |

### PTOCA Control Sequences (inside PTX data)

**Unchained format:** `0x2B 0xD3` prefix, then chained CSs follow.

**Chained CS format:** `[LENGTH:1] [TYPE:1] [PARAMS:LENGTH-2]`

| CS Type | Name | Params | Description |
|---------|------|--------|-------------|
| 0xC0 | AMI | X:2 | Absolute Move Inline (set X position) |
| 0xC1 | AMI2 | X:2 | AMI variant |
| 0xC7 | STC | X:2 | Set Text Position (inline X) |
| 0xC8 | RMI | dX:2 | Relative Move Inline |
| 0xD0 | SBI | inc:2 | Set Baseline Increment |
| 0xD1 | AMB2 | val:2 | Baseline value (increment if ≤100, absolute if >100) |
| 0xD2 | AMB | Y:2 | Absolute Move Baseline (absolute Y) |
| 0xD3 | AMB3 | val:2 | Baseline value (increment if ≤100, absolute if >100) |
| 0xD4 | RMB | dY:2 | Relative Move Baseline |
| 0xD8 | BLN | - | Begin Line (advance by baseline increment) |
| 0xD9 | D9 | - | New line (advance Y by baseline increment) |
| 0xDA | TRN | text | Transparent Data (EBCDIC text follows) |
| 0xDB | TRN | text | Transparent Data (EBCDIC or UTF-16BE text) |
| 0xC5 | C5 | idx:2 | Set Coded Font (font resource index, NOT point size) |
| 0xF1 | SCFL | localId:1 | Set Coded Font Local — selects font by local ID; resolve via MCF (D3AB8A) to get character set name and infer weight. NOT a weight value itself. |
| 0xF6 | STO | 4 bytes | Set Text Orientation |
| 0xF7 | STO2 | 4 bytes | Set Text Orientation (variant) |
| 0x80 | SEC | color | Set Extended Color: [space:1][R:1][G:1][B:1] or indexed |
| 0x81 | SCFL | id:1 | Set Coded Font Local |
| 0xE5 | E5 | 5 bytes | Line/area definition |
| 0xE7 | E7 | 5 bytes | Area definition |
| 0xF8 | NOP | - | No Operation |

### Text Encoding Detection

| Pattern | Encoding | Description |
|---------|----------|-------------|
| 0xDB CS contains `00 XX 00 XX` pairs | UTF-16BE | Unicode fonts |
| 0xDB CS contains EBCDIC bytes | CP500/CP037 | Standard EBCDIC |
| 0x2BD3 prefix present | Unchained | All chained CSs follow after prefix |

### F1 (SCFL) — Two Dialects

**Important:** the meaning of the byte after `0xF1` differs between the EBCDIC chained dialect and the UTF-16BE Unicode dialect.

#### EBCDIC chained dialect

`F1` is the standard PTOCA **SCFL (Set Coded Font Local)** control sequence. The byte is a font local ID that must be resolved via the MCF (D3AB8A) Map Coded Font triplets — it is **NOT** a font weight. Interpreting `byte >= 6` as bold causes every text run to render bold (because real local IDs are typically 0x0B, 0x0D, etc.).

**Bold detection via MCF + character set name:** Each MCF repeating group provides a Coded Font Name (FQN type 0x85, e.g. `T10D1144`) and a Character Set Name (FQN type 0x86, e.g. `C0FL20A0`). The 4th character of the C-prefixed character set name encodes the weight within the family:

| 4th char | Meaning | Example |
|----------|---------|---------|
| `L` | Light / regular | `C0FL20A0`, `C0FL2060` |
| `M` | Medium / **bold** | `C0FM20E0`, `C0FM2080` |
| `B` | Bold | `C0xB...` |
| `H` | Heavy | `C0xH...` |
| (other) | default to regular | `C0G0001Q` |

Verified against a sample EBCDIC file:
- font ID 5 → `C0FL20A0` → regular (body text)
- font ID 7 → `C0FM20E0` → **bold** (headings, account labels)
- font ID 8 → `C0FL2060` → regular (small text)

#### UTF-16BE Unicode dialect

A vendor-specific repurposing of `F1` as a style preset:

| F1 Value | Style | Description |
|----------|-------|-------------|
| 1 | Bold (address) | Recipient name and address lines |
| 2 | Title (large, blue) | Document title / heading |
| 3 | Normal body | Standard paragraph text |
| 4 | Bold body | Emphasized paragraph text |
| 5 | Small bold | Table headers |
| 6 | Underline link (blue) | Hyperlink-style text |

Detection: if `isUnicodeFormat()` returns true, use the style-preset table; otherwise treat F1 as SCFL.

## Image Fields (IOCA)

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8C5 | BIM | Begin Image | IOCA image container |
| D3A9C5 | EIM | End Image | |
| D3ACCE | IDD | Image Data Descriptor | IOCA dimensions/compression |
| D3EE7B | IDE | Image Data | IOCA pixel data |

## Image Fields (IM Image — Legacy)

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8FB | BII | Begin IM Image | Legacy image container (8-byte EBCDIC name) |
| D3A9FB | EII | End IM Image | |
| D3A6FB | IDD2 | Image Input Descriptor | Contains SDF 0xB8 or resolution+width |
| D3EEFB | IRD | Image Raster Data | 1-bit bitmap, first IRD has 0x70 cell header |

### IRD Cell Header Format (0x70 command)

```
Byte 0: 0x70 (cell command)
Bytes 1-2: cell parameter length
Byte 3: flags (0x01 = new cell)
Byte 4: fill byte (0xFF = white)
Then Self-Defining Fields (SDFs):
  0x94 [len] [xRes:2][yRes:2][width:2][height:2] — Image Size
  0x95 [len] [compression:1][flags] — Image Encoding
  0x96 [len] [bits:1] — IDE Size (bits per pixel)
  0x97 [len] [model:1] — Image Color Model
  0x9B [len] [extended size data] — Extended Image Size
Then 0xFE 0x92 [width:2] marks start of pixel data
```

### IM Image Rendering

- **SDF 0x96** determines bits per pixel: `0x01` = 1-bit bi-level, `0x08` = 8-bit grayscale
- **Width** from SDF 0x94 bytes 5-6 (pixels)
- **Height** from SDF 0x94 bytes 7-8, OR = total bands count
- **Resolution** from SDF 0x94 bytes 1-2 (units per 10 inches ÷ 10 = DPI)
- **Band structure**: pixel data is organized in bands, each: `FE 92 [width:2] [pixel_data:bytesPerRow]`
  - For 8bpp: bytesPerRow = width (each byte = one pixel)
  - For 1bpp: bytesPerRow = ceil(width / 8)
  - Band size = 4 + bytesPerRow
  - Multiple bands per IRD (e.g. 5 bands × 104 IRDs = 520 rows)
- **1-bit polarity:** bit 1 = white, bit 0 = black
- **8-bit grayscale:** 0x00 = black, 0xFF = white
- **Two IRD formats:**
  - **Banded:** FE92 markers present, each band = one scan line. Cell header + pixel data in SAME IRD.
  - **Unbanded:** No FE92 markers. Cell header in FIRST IRD (small, <100 bytes, starts with 0x70). Pixel data in subsequent IRDs as raw bytes.
- **Cell header can be in its own IRD** — when first IRD is ≤100 bytes, it's header-only. Skip it for pixel data.
- **SDF 0x95** = Compression flag: `0x03` with flags `0x01` = RAW uncompressed bitmap (NOT G3 Huffman!)
- **IM Image compression is misleading** — despite SDF 0x95=0x03, the data is raw 1-bit bitmap in AFP files
- **Polarity auto-detection**: count 1-bits in first row. Mostly 1s → 0=black. Mostly 0s → 1=black.
- **FE92 band markers per IRD**: IRDs after the first may start with `FE 92 [bandSize:2]`. Strip these 4 bytes before concatenating pixel data. The bandSize is the DATA size in the band, NOT the image width.
- **Pixel data flows across IRD boundaries** — rows are NOT aligned to IRDs. Concatenate all data then split by bytesPerRow.

### CRITICAL: 1bpp vs 8bpp rendering difference

| Property | 1bpp (unbanded type) | 8bpp (banded type) |
|----------|---------------------|---------------------|
| Cell header | Separate tiny IRD (30-38 bytes) | Inside first large IRD (7143 bytes) |
| IRD[1] data | Raw pixels, NO FE92 | Raw pixels, NO FE92 |
| IRD[2]+ data | HAS FE92 prefix (4 bytes) | NO FE92 prefix |
| Band mode | **UNBANDED** — strip FE92 per-IRD, concatenate all, split by bpr | **BANDED** — FE92 markers inside first IRD define rows |
| Polarity | Auto-detect from first row | 0x00=black, 0xFF=white |
| bytesPerRow | ceil(width/8) | width |

**The key fix:** For 1bpp images, strip FE92 headers from each IRD during collection, then treat ALL concatenated data as continuous unbanded rows. Do NOT use band-mode parsing for 1bpp — the FE92 markers are IRD-level headers, not row-level band markers.

## Object Container Fields

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8CE | BOC | Begin Object Container | Named container (8-byte EBCDIC name) |
| D3A9CE | EOC | End Object Container | |
| D3A8CC | BOC | Begin Object Container (alt) | Alternate type |
| D3A9CC | EOC | End Object Container (alt) | |
| D3EEBB | OCD | Object Container Data | Data payload (JPEG, PNG, BCOCA, etc.) |

### OCD Data Format Detection

| Magic Bytes | Format | Displayable |
|-------------|--------|-------------|
| FF D8 | JPEG | Yes — direct `<img>` |
| 89 50 4E 47 | PNG | Yes — direct `<img>` |
| 47 49 46 | GIF | Yes — direct `<img>` |
| 42 4D | BMP | Yes — direct `<img>` |
| 49 49 / 4D 4D | TIFF | Browser-dependent |
| 25 50 44 46 | PDF | Yes — `<iframe>` |
| 70 0C | IOCA segment / GOCA vector (QR codes) | No — needs GOCA renderer |
| C0 0A | GOCA GBOX commands (QR codes) | Yes — render as filled rectangles |

### QR Code in OCD (GOCA Vector Format)

QR codes are drawn as individual modules using GBOX commands:
```
68 80 C0 0A [flags:1] [reserved:1] [x1:2 BE] [y1:2 BE] [x2:2 BE] [y2:2 BE]
```
- `68 80` = Begin tile/area
- `C0 0A` = GBOX draw box, 10 bytes params
- Coordinates: two corners (x1,y1) and (x2,y2) in GOCA units
- Y axis is inverted (bottom-left origin) — flip for canvas rendering
- Typical QR: ~1588 rectangles, bounds 0-543 units (57×57 modules)
| Other | AFP-specific data | No |

## Graphics (GOCA)

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8C3 | BGR | Begin Graphics | GOCA vector graphics |
| D3A9C3 | EGR | End Graphics | |
| D3EECC | GAD | Graphics Data | Drawing orders |

## Barcode (BCOCA)

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A8EB | BBC | Begin Bar Code | |
| D3A9EB | EBC | End Bar Code | |
| D3AEEB | BDD | Bar Code Data Descriptor | |

## Overlay & Page Segment

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A85F | BPS | Begin Page Segment | Reusable page component. Data: `[name:8]` EBCDIC. Contains IM Images (BII/IRD/EII) or GOCA graphics (BDI/OCD/EDI). |
| D3A95F | EPS | End Page Segment | |
| D3A8DF | BOV | Begin Overlay | |
| D3A9DF | EOV | End Overlay | |
| D3AFD8 | IPO | Include Page Overlay | Position: `[name:8][xPos:3][yPos:3]` — text coords are ABSOLUTE, not relative to IPO |
| D3AF5F | IPS | Include Page Segment | Data: `[segName:8][xPos:3][yPos:3]`. References BPS resource by name. Segment may contain IM Image data or GOCA graphics (QR codes rendered as GBOX orders). |
| D3AFC3 | IOC | Include Object | References inline resource by name |

### Page Segment GOCA Content (QR Codes)

Page segments containing GOCA graphics have this internal structure:
- BPS → BDI → BDG → descriptors → EDG/EDI → OCD chunks → EDI → EPS
- OCD data format: `[cell_header][sub_descriptors][padding][GOCA_orders]`
- Cell header: `70 LL` (LL = param length), followed by object ID and SDFs
- Sub-descriptors: `B2 LL ...` (LL = total length including B2 LL)
- GOCA orders: GBAREA(68)/GEAREA(60) wrapping GBOX(C0) for filled modules
- GBOX params: `[flags:1][reserved:1][Xpos:2][Ypos:2][Xext:2][Yext:2]` — Xext/Yext are OPPOSITE CORNER coordinates, not width/height
- GBAREA flag byte `0x80` = filled area; boxes inside are filled with current draw color
- **Resolution**: GDD (D3A66B) contains segment resolution, typically 3000/10in = 300/inch. Page uses 1440/inch. Coordinate scale ratio = 1440/300 = 4.8. GOCA coordinates must be multiplied by this ratio before rendering at page scale.
- Swiss QR bill: version 10 (57x57 modules), ~1594 filled boxes, each ~10x10 segment units, total ~543x543 units = 46mm

## Font & Code Page

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3AB8A | MCF | Map Coded Font (MCF-1) | Repeating groups of triplets: 0x24 (RLI = local ID), 0x02 (FQN: 0x85=Coded Font Name, 0x86=Character Set Name). RG layout: `[2-byte length][triplets...]`. See "F1 (SCFL) — Two Dialects" above. |
| D3ABC3 | MCF | Map Coded Font (alt) | Alternate MCF type ID seen in some files |
| D3A885 | BCF | Begin Coded Font | |
| D3A985 | ECF | End Coded Font | |
| D3A887 | BCS | Begin Character Set | |
| D3A987 | ECS | End Character Set | |
| D3A889 | BCP | Begin Code Page | |
| D3A989 | ECP | End Code Page | |
| D3A689 | CPD | Code Page Descriptor | Contains font name (EBCDIC) |
| D3A789 | CPC | Code Page Control | |
| D3AC89 | CPI | Code Page Index | Byte→Unicode mappings |
| D3AE89 | CPM | Code Page Map | |
| D38C89 | CPF | Code Page Font | |
| D38C87 | CSF | Character Set Font | |
| D3A687 | CSD | Character Set Descriptor | |
| D3EE87 | FNP | Font Pattern | Glyph bitmap data |
| D3AE87 | FNM | Font Pattern Map | |
| D3A8A6 | BFN | Begin Font | |
| D3A9A6 | EFN | End Font | |
| D3A6EE | FNC | Font Control | |

## Medium Map & Form Definition

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A888 | BMM | Begin Medium Map | |
| D3A988 | EMM | End Medium Map | |
| D3AB88 | IMM | Invoke Medium Map | |
| D3A88A | BFM | Begin Form Map | |
| D3A98A | EFM | End Form Map | |
| D3B18A | MMC | Medium Modification Control | |
| D3ABD8 | MPO | Map Page Overlay | |
| D3B15F | MPS | Map Page Segment | |
| D3ABCC | MCC | Medium Copy Count | |
| D3A688 | MDD | Medium Descriptor | |

## Metadata

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3A090 | TLE | Tag Logical Element | Key-value metadata. Triplets: 0x02=name (EBCDIC), 0x36=value (EBCDIC) |
| D3A8BB | BDI | Begin Document Index | |
| D3A9BB | EDI | End Document Index | |
| D3A6BB | IDD2 | Index Element Descriptor | |

## Other Fields

| Type ID | Abbrev | Full Name | Description |
|---------|--------|-----------|-------------|
| D3AFEE | NOP | No Operation | Metadata/comments |
| D3A8EE | NOP | No Operation (alt) | |
| D3B1AF | PPO | Preprocess Object | |
| D3A79B | PEC | Pres Environment Control | |
| D3A69B | PFC | Pres Fidelity Control | |
| D3A6C5 | MDD | Medium Descriptor | |
| D3A288 | MDR | Medium Data Record | |
| D3A788 | MMC2 | Medium Modification Ctrl | |

---

## EBCDIC Code Pages

### CP500 (International) — Default for European AFP files

Key positions differing from CP037:
| Byte | CP037 | CP500 | Notes |
|------|-------|-------|-------|
| 0xB5 | § | **@** | At sign |
| 0xC0 | { | **ä** | German a-umlaut |
| 0xD0 | } | **ü** | German u-umlaut |
| 0xDC | Ü | **ü** | Changed to lowercase for German text |
| 0xA1 | ~ | **ß** | German sharp s |
| 0xE0 | \ | **Ö** | German O-umlaut |
| 0xCC | ö | **ö** | German o-umlaut (same) |
| 0x43 | â | **ä** | In CP037 context |
| 0x59 | ß | **ß** | Sharp s (same) |

### Font Detection

- AFP files embed fonts as Code Page + Character Set resources
- `CPD` (D3A689) contains the font name (EBCDIC)
- Common font: **DejaVu Sans Condensed** (identified by EBCDIC "DV S C B" in CPD)
- Renderer uses: `"DejaVu Sans Condensed", "DejaVu Sans", Arial, Helvetica, sans-serif`

---

## Page Boundary Detection Strategy

Priority order (use strategy with MOST pages):
1. **BPG/EPG** (D3A8AD/D3A9AD) — Standard pages
2. **BRS/ERS** (D3A8AF/D3A9AF) — Resource blocks (each = physical page)
3. **BDT/EDT** (D3A8A8/D3A9A8) — Document blocks
4. **BPF/EPF** (D3A8A5/D3A9A5) — Print file blocks
5. **Fallback** — Entire file as 1 page

When BRS count > BPG count: each BRS is a separate physical page (letter + payment slip = 2 BRS per BPG).

---

## Known Issues & Workarounds

1. **IPO offsets are NOT additive** — text runs have absolute page coordinates
2. **Multiple BRS per BPG** — use BRS/ERS as page boundaries (more pages = more correct)
3. **D3/D1 CS ambiguity** — values >100 = absolute Y, ≤100 = baseline increment
4. **C5 is font INDEX** — not a point size. Use default 10pt.
5. **Landscape detection** — if max text X > page width, swap width/height
6. **Footer overlap** — tight Y spacing with small fonts, auto-detect from line spacing
