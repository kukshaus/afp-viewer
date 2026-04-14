# PRD: IM Image Parser & Preview

## Overview
Parse legacy AFP IM Image resources (BII/IDD2/IRD/EII) to extract bitmap images for preview display.

## IM Image Structure

### Field Hierarchy
```
BII (D3A8FB) — Begin IM Image (8-byte resource name)
  IDD2 (D3A6FB) — Image Input Descriptor (dimensions & resolution)
  IRD (D3EEFB) — Image Raster Data (1+ fields, raw bitmap)
EII (D3A9FB) — End IM Image
```

### IDD2 Format (Image Input Descriptor)
13 bytes containing a single Self-Defining Field:
```
Bytes 0-1: SDF length (0x000B = 11)
Byte 2:    SDF type (0xB8 = Image Size)
Bytes 3-4: H resolution (e.g. 0x0BB8 = 3000 = 300 DPI)
Bytes 5-6: Image width in pixels (e.g. 0x0250 = 592)
Bytes 7-8: Encoding flags + height indicator
Bytes 9-10: Additional parameters
```

### IRD Format (Image Raster Data)
- First IRD contains a cell header (0x70 command, ~30 bytes)
- Subsequent IRDs contain raw 1-bit bitmap data
- Pixels: bit 0 = white, bit 1 = black (or vice versa depending on flags)
- Width from IDD2 determines bytes per row: `ceil(width / 8)`
- Height = total pixel data / (width in pixels)

### Image Rendering
1. Parse IDD2 to get width (pixels) and resolution (DPI)
2. Collect all IRD data (skip cell headers starting with 0x70)
3. Interpret as 1-bit bitmap: each byte = 8 pixels
4. Render to canvas → export as PNG data URL

## Implementation
- File: `src/lib/afp/im-image-parser.ts`
- Integration: ElementTree preview panel
- Trigger: clicking BII, IRD, or parent BOC nodes
