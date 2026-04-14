/**
 * BCOCA Bar Code Renderer
 *
 * Draws BCOCAObject barcodes onto a CanvasRenderingContext2D.
 * Supports Code 39, Code 128, EAN-13, UPC-A, Interleaved 2-of-5,
 * QR Code, Data Matrix, and PDF417.
 *
 * For 1D barcodes we render the bars directly. For 2D barcodes (QR,
 * Data Matrix, PDF417) we render a placeholder with the payload text
 * since full 2D encoding would require a dedicated library.
 */

import { type BCOCAObject, type AFPColor, BarcodeType } from '@/lib/afp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colorToCSS(c: AFPColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
}

/**
 * Encodes a string into Code 128 bar/space widths using Code B character set.
 * Returns an array of 0/1 values representing module states (bar=1, space=0).
 */
function encodeCode128B(data: string): number[] {
  // Code 128 patterns (bar-space widths for each symbol)
  // Each pattern is 6 alternating widths (bar, space, bar, space, bar, space) summing to 11 modules.
  const PATTERNS: number[][] = [
    [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],
    [1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],
    [2,2,1,3,1,2],[2,3,1,2,1,2],[1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],
    [1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
    [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],[3,1,1,2,2,2],
    [3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
    [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],
    [1,3,1,3,2,1],[1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
    [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
    [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[3,1,3,1,2,1],[2,1,1,3,3,1],
    [2,3,1,1,3,1],[2,1,3,1,1,3],[2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],
    [3,1,1,3,2,1],[3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
    [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],
    [1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],[1,4,1,2,2,1],[1,1,2,2,1,4],
    [1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],
    [2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
    [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],
    [1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],
    [2,1,4,1,2,1],[4,1,2,1,2,1],[1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],
    [1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
    [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],[2,1,1,2,1,4],
    [2,1,1,2,3,2],[2,3,3,1,1,1],[2,1,1,1,3,2],
  ];

  const START_B = 104;
  const STOP = [2,3,3,1,1,1,2]; // stop pattern (7 bars)

  const modules: number[] = [];

  function addPattern(pattern: number[]): void {
    let isBar = true;
    for (const width of pattern) {
      for (let w = 0; w < width; w++) {
        modules.push(isBar ? 1 : 0);
      }
      isBar = !isBar;
    }
  }

  // Start code B
  let checksum = START_B;
  addPattern(PATTERNS[START_B]);

  // Data characters
  for (let i = 0; i < data.length; i++) {
    const charCode = data.charCodeAt(i);
    const value = charCode - 32;
    if (value >= 0 && value < PATTERNS.length) {
      addPattern(PATTERNS[value]);
      checksum += value * (i + 1);
    }
  }

  // Checksum
  const checksumValue = checksum % 103;
  if (checksumValue < PATTERNS.length) {
    addPattern(PATTERNS[checksumValue]);
  }

  // Stop
  let isBar = true;
  for (const width of STOP) {
    for (let w = 0; w < width; w++) {
      modules.push(isBar ? 1 : 0);
    }
    isBar = !isBar;
  }

  return modules;
}

/**
 * Encodes a string into Code 39 bar/space modules.
 */
function encodeCode39(data: string): number[] {
  const CHARS: Record<string, string> = {
    '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnn0',
    '4':'nnnwwnnnw','5':'wnnwwnnn0','6':'nnwwwnnn0','7':'nnnwnnwnw',
    '8':'wnnwnnwn0','9':'nnwwnnwn0','A':'wnnnnwnnw','B':'nnwnnwnnw',
    'C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn',
    'G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
    'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww',
    'O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn',
    'S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw',
    'W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn',
    '-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn',
    '+':'nwnnnwnwn','/':'nwnwnnnwn','$':'nwnwnwnnn','%':'nnnwnwnwn',
  };

  const modules: number[] = [];
  const wrapped = `*${data.toUpperCase()}*`;

  for (let ci = 0; ci < wrapped.length; ci++) {
    const ch = wrapped[ci];
    const pattern = CHARS[ch];
    if (!pattern) continue;

    for (let i = 0; i < pattern.length; i++) {
      const isBar = i % 2 === 0;
      const isWide = pattern[i] === 'w';
      const width = isWide ? 3 : 1;
      for (let w = 0; w < width; w++) {
        modules.push(isBar ? 1 : 0);
      }
    }
    // Inter-character gap
    modules.push(0);
  }

  return modules;
}

/**
 * Simple EAN-13 / UPC-A encoding. Returns module array.
 */
function encodeEAN13(data: string): number[] {
  const LEFT_ODD: number[][] = [
    [0,0,0,1,1,0,1],[0,0,1,1,0,0,1],[0,0,1,0,0,1,1],[0,1,1,1,1,0,1],
    [0,1,0,0,0,1,1],[0,1,1,0,0,0,1],[0,1,0,1,1,1,1],[0,1,1,1,0,1,1],
    [0,1,1,0,1,1,1],[0,0,0,1,0,1,1],
  ];
  const LEFT_EVEN: number[][] = [
    [0,1,0,0,1,1,1],[0,1,1,0,0,1,1],[0,0,1,1,0,1,1],[0,1,0,0,0,0,1],
    [0,0,1,1,1,0,1],[0,1,1,1,0,0,1],[0,0,0,0,1,0,1],[0,0,1,0,0,0,1],
    [0,0,0,1,0,0,1],[0,0,1,0,1,1,1],
  ];
  const RIGHT: number[][] = [
    [1,1,1,0,0,1,0],[1,1,0,0,1,1,0],[1,1,0,1,1,0,0],[1,0,0,0,0,1,0],
    [1,0,1,1,1,0,0],[1,0,0,1,1,1,0],[1,0,1,0,0,0,0],[1,0,0,0,1,0,0],
    [1,0,0,1,0,0,0],[1,1,1,0,1,0,0],
  ];
  const PARITY: number[][] = [
    [0,0,0,0,0,0],[0,0,1,0,1,1],[0,0,1,1,0,1],[0,0,1,1,1,0],
    [0,1,0,0,1,1],[0,1,1,0,0,1],[0,1,1,1,0,0],[0,1,0,1,0,1],
    [0,1,0,1,1,0],[0,1,1,0,1,0],
  ];

  const padded = data.padStart(13, '0').slice(0, 13);
  const digits = padded.split('').map(Number);
  const modules: number[] = [];

  // Start guard
  modules.push(1, 0, 1);

  // Left half (digits 1-6)
  const parityPattern = PARITY[digits[0]] ?? PARITY[0];
  for (let i = 1; i <= 6; i++) {
    const d = digits[i];
    const encoding = parityPattern[i - 1] === 0 ? LEFT_ODD[d] : LEFT_EVEN[d];
    if (encoding) modules.push(...encoding);
  }

  // Centre guard
  modules.push(0, 1, 0, 1, 0);

  // Right half (digits 7-12)
  for (let i = 7; i <= 12; i++) {
    const d = digits[i];
    const encoding = RIGHT[d];
    if (encoding) modules.push(...encoding);
  }

  // End guard
  modules.push(1, 0, 1);

  return modules;
}

// ---------------------------------------------------------------------------
// 1D barcode rendering
// ---------------------------------------------------------------------------

/**
 * Draws a 1D barcode from a module array.
 */
function draw1DBarcode(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  modules: number[],
  x: number,
  y: number,
  moduleWidthPx: number,
  heightPx: number,
  barColor: string,
): void {
  ctx.fillStyle = barColor;
  let xPos = x;

  for (const m of modules) {
    if (m === 1) {
      ctx.fillRect(xPos, y, moduleWidthPx, heightPx);
    }
    xPos += moduleWidthPx;
  }
}

// ---------------------------------------------------------------------------
// 2D barcode placeholder
// ---------------------------------------------------------------------------

/**
 * Draws a placeholder rectangle for 2D barcodes with the payload text.
 */
function draw2DPlaceholder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  label: string,
  barColor: string,
): void {
  ctx.strokeStyle = barColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);

  // Draw a grid pattern to suggest a 2D code
  const cellSize = size / 10;
  ctx.fillStyle = barColor;
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 10; col++) {
      // Deterministic pattern based on label hash
      const hash = (label.charCodeAt(row % label.length) * 31 + col * 17 + row * 7) & 0xff;
      if (hash > 128) {
        ctx.fillRect(x + col * cellSize, y + row * cellSize, cellSize, cellSize);
      }
    }
  }

  // Label
  ctx.fillStyle = barColor;
  ctx.font = `${Math.max(8, Math.round(size * 0.08))}px monospace`;
  ctx.textBaseline = 'top';
  const truncated = label.length > 20 ? label.slice(0, 17) + '...' : label;
  ctx.fillText(truncated, x, y + size + 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a BCOCA barcode object onto a 2D canvas context.
 *
 * @param ctx         - The canvas 2D rendering context.
 * @param barcodeObj  - The parsed BCOCA barcode object.
 * @param offsetX     - Horizontal pixel offset for the object's container position.
 * @param offsetY     - Vertical pixel offset for the object's container position.
 * @param scaleFactor - Combined DPI/zoom scale: (dpi / resolution) * zoom.
 */
export function renderBarcode(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  barcodeObj: BCOCAObject,
  offsetX: number,
  offsetY: number,
  scaleFactor: number,
): void {
  ctx.save();

  const bx = offsetX + barcodeObj.x * scaleFactor;
  const by = offsetY + barcodeObj.y * scaleFactor;
  const moduleWidthPx = Math.max(1, barcodeObj.moduleWidth * scaleFactor);
  const barHeightPx = Math.max(10, barcodeObj.barHeight * scaleFactor);
  const barColor = colorToCSS(barcodeObj.color);

  // Apply rotation if needed
  if (barcodeObj.orientation !== 0) {
    ctx.translate(bx, by);
    ctx.rotate((barcodeObj.orientation * Math.PI) / 180);
    ctx.translate(-bx, -by);
  }

  let modules: number[];

  switch (barcodeObj.barcodeType) {
    case BarcodeType.Code128:
      modules = encodeCode128B(barcodeObj.data);
      draw1DBarcode(ctx, modules, bx, by, moduleWidthPx, barHeightPx, barColor);
      break;

    case BarcodeType.Code39:
      modules = encodeCode39(barcodeObj.data);
      draw1DBarcode(ctx, modules, bx, by, moduleWidthPx, barHeightPx, barColor);
      break;

    case BarcodeType.EAN13:
    case BarcodeType.UPC_A:
      modules = encodeEAN13(barcodeObj.data);
      draw1DBarcode(ctx, modules, bx, by, moduleWidthPx, barHeightPx, barColor);
      break;

    case BarcodeType.Interleaved2of5: {
      // Simple I2of5: alternate thick/thin bars
      modules = [];
      const chars = barcodeObj.data.replace(/[^0-9]/g, '');
      for (let i = 0; i < chars.length; i++) {
        const d = parseInt(chars[i], 10);
        // Simplified: wide for odd digits, narrow for even
        const isWide = d % 2 === 1;
        const barW = isWide ? 3 : 1;
        const isBar = i % 2 === 0;
        for (let w = 0; w < barW; w++) {
          modules.push(isBar ? 1 : 0);
        }
      }
      draw1DBarcode(ctx, modules, bx, by, moduleWidthPx, barHeightPx, barColor);
      break;
    }

    case BarcodeType.QR:
    case BarcodeType.DataMatrix:
    case BarcodeType.PDF417: {
      const size = Math.max(40, barHeightPx);
      draw2DPlaceholder(ctx, bx, by, size, barcodeObj.data, barColor);
      break;
    }

    default: {
      // Unknown barcode type: render as Code 128 fallback
      modules = encodeCode128B(barcodeObj.data);
      draw1DBarcode(ctx, modules, bx, by, moduleWidthPx, barHeightPx, barColor);
      break;
    }
  }

  // Human-readable text label below the barcode
  if (barcodeObj.humanReadable) {
    const fontSize = Math.max(8, Math.round(barHeightPx * 0.15));
    ctx.fillStyle = barColor;
    ctx.font = `${fontSize}px monospace`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    const totalWidth =
      barcodeObj.barcodeType === BarcodeType.QR ||
      barcodeObj.barcodeType === BarcodeType.DataMatrix ||
      barcodeObj.barcodeType === BarcodeType.PDF417
        ? barHeightPx
        : (modules!.length ?? barcodeObj.data.length * 11) * moduleWidthPx;

    ctx.fillText(barcodeObj.data, bx + totalWidth / 2, by + barHeightPx + 2);
    ctx.textAlign = 'start';
  }

  ctx.restore();
}
