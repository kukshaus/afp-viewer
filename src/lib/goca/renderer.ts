/**
 * GOCA Graphics Renderer
 *
 * Draws GOCAObject drawing orders onto a CanvasRenderingContext2D.
 * Each drawing order is interpreted as a canvas path operation.
 */

import {
  type GOCAObject,
  type GOCADrawingOrder,
  type AFPColor,
  GOCADrawingOrderType,
} from '@/lib/afp/types';

/**
 * Converts an AFPColor to a CSS rgba() string.
 */
function colorToCSS(c: AFPColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
}

/**
 * Reads a signed 16-bit value from the params array at the given index.
 * GOCA coordinates are typically 16-bit signed values in L-units.
 */
function readInt16(params: number[], index: number): number {
  if (index + 1 >= params.length) return 0;
  const val = (params[index] << 8) | params[index + 1];
  return val > 0x7fff ? val - 0x10000 : val;
}

/**
 * Current drawing state maintained while processing drawing orders.
 */
interface DrawState {
  color: AFPColor;
  lineWidth: number;
  lineType: number; // 0 = solid, 1 = dashed, 2 = dotted, etc.
  fillColor: AFPColor | null;
  inArea: boolean; // inside GBAREA/GEAREA boundary
  areaFilled: boolean; // area should be filled
  curX: number;
  curY: number;
}

function defaultDrawState(): DrawState {
  return {
    color: { r: 0, g: 0, b: 0, a: 255 },
    lineWidth: 1,
    lineType: 0,
    fillColor: null,
    inArea: false,
    areaFilled: false,
    curX: 0,
    curY: 0,
  };
}

/**
 * Sets the canvas line dash pattern based on the GOCA line type.
 */
function applyLineType(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  lineType: number,
  lineWidth: number,
): void {
  switch (lineType) {
    case 1: // dashed
      ctx.setLineDash([lineWidth * 4, lineWidth * 2]);
      break;
    case 2: // dotted
      ctx.setLineDash([lineWidth, lineWidth * 2]);
      break;
    case 3: // dash-dot
      ctx.setLineDash([lineWidth * 4, lineWidth, lineWidth, lineWidth]);
      break;
    default: // solid
      ctx.setLineDash([]);
  }
}

/**
 * Processes a single drawing order and draws it on the canvas.
 */
function processOrder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  order: GOCADrawingOrder,
  state: DrawState,
  scaleFactor: number,
  offsetX: number,
  offsetY: number,
): void {
  const p = order.params;
  const sf = scaleFactor;

  switch (order.type) {
    // GBAREA (0x68) — Begin Area boundary; flag byte 0x80 = filled
    case 0x68 as GOCADrawingOrderType: {
      state.inArea = true;
      state.areaFilled = p.length > 0 && (p[0] & 0x80) !== 0;
      // Start accumulating a path for the area
      ctx.beginPath();
      ctx.moveTo(offsetX + state.curX * sf, offsetY + state.curY * sf);
      break;
    }

    // GEAREA (0x60) — End Area boundary; fill the accumulated path
    case 0x60 as GOCADrawingOrderType: {
      if (state.areaFilled) {
        ctx.closePath();
        ctx.fillStyle = state.fillColor ? colorToCSS(state.fillColor) : colorToCSS(state.color);
        ctx.fill();
      }
      state.inArea = false;
      state.areaFilled = false;
      break;
    }

    // GSCP (0x21) — Set Current Position (with length byte format)
    case 0x21 as GOCADrawingOrderType: {
      if (p.length >= 4) {
        state.curX = readInt16(p, 0);
        state.curY = readInt16(p, 2);
        if (state.inArea) {
          // Move to the starting position within the area path
          ctx.moveTo(offsetX + state.curX * sf, offsetY + state.curY * sf);
        }
      }
      break;
    }

    case GOCADrawingOrderType.GSCOL: {
      // Set colour: params[0..2] are R, G, B (or a colour index)
      if (p.length >= 3) {
        state.color = { r: p[0], g: p[1], b: p[2], a: 255 };
      }
      break;
    }

    case GOCADrawingOrderType.GSLW: {
      // Set line width: params[0..1] are 16-bit multiplier
      state.lineWidth = Math.max(1, readInt16(p, 0) * sf);
      break;
    }

    case GOCADrawingOrderType.GSLT: {
      // Set line type
      state.lineType = p.length > 0 ? p[0] : 0;
      break;
    }

    case GOCADrawingOrderType.GSFLW: {
      // Set fill: params[0] = fill flag, params[1..3] = R,G,B
      if (p.length >= 4 && p[0] !== 0) {
        state.fillColor = { r: p[1], g: p[2], b: p[3], a: 255 };
      } else {
        state.fillColor = null;
      }
      break;
    }

    case GOCADrawingOrderType.GLINE: {
      // Line: params = [x1_hi, x1_lo, y1_hi, y1_lo, x2_hi, x2_lo, y2_hi, y2_lo]
      if (p.length >= 8) {
        const x1 = offsetX + readInt16(p, 0) * sf;
        const y1 = offsetY + readInt16(p, 2) * sf;
        const x2 = offsetX + readInt16(p, 4) * sf;
        const y2 = offsetY + readInt16(p, 6) * sf;

        ctx.strokeStyle = colorToCSS(state.color);
        ctx.lineWidth = state.lineWidth;
        applyLineType(ctx, state.lineType, state.lineWidth);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        state.curX = readInt16(p, 4);
        state.curY = readInt16(p, 6);
      }
      break;
    }

    case GOCADrawingOrderType.GCLINE: {
      // Current-position line: draw from current pos to (x, y)
      if (p.length >= 4) {
        const x2 = offsetX + readInt16(p, 0) * sf;
        const y2 = offsetY + readInt16(p, 2) * sf;

        if (state.inArea) {
          // Add to area path (will be filled at GEAREA)
          ctx.lineTo(x2, y2);
        } else {
          const x1 = offsetX + state.curX * sf;
          const y1 = offsetY + state.curY * sf;
          ctx.strokeStyle = colorToCSS(state.color);
          ctx.lineWidth = state.lineWidth;
          applyLineType(ctx, state.lineType, state.lineWidth);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }

        state.curX = readInt16(p, 0);
        state.curY = readInt16(p, 2);
      }
      break;
    }

    case GOCADrawingOrderType.GBOX:
    case GOCADrawingOrderType.GCBOX: {
      // GBOX: params = [flags, reserved, Xpos:2, Ypos:2, Xext:2, Yext:2]
      // Xext/Yext are the opposite corner coordinates (not width/height).
      // Compute the bounding rectangle from the two corners.
      if (p.length >= 10) {
        const x1 = readInt16(p, 2);
        const y1 = readInt16(p, 4);
        const x2 = readInt16(p, 6);
        const y2 = readInt16(p, 8);

        const bx = offsetX + Math.min(x1, x2) * sf;
        const by = offsetY + Math.min(y1, y2) * sf;
        const bw = Math.abs(x2 - x1) * sf;
        const bh = Math.abs(y2 - y1) * sf;

        // Fallback: if width/height are zero but values look like size (not coords),
        // use the raw values as size (backward compat with position+size format)
        const drawW = bw > 0 ? bw : Math.abs(readInt16(p, 6)) * sf;
        const drawH = bh > 0 ? bh : Math.abs(readInt16(p, 8)) * sf;

        ctx.lineWidth = state.lineWidth;
        applyLineType(ctx, state.lineType, state.lineWidth);

        // Fill if: explicit fill color set, OR inside a filled area (GBAREA)
        if (state.fillColor) {
          ctx.fillStyle = colorToCSS(state.fillColor);
          ctx.fillRect(bx, by, drawW, drawH);
        } else if (state.inArea && state.areaFilled) {
          ctx.fillStyle = colorToCSS(state.color);
          ctx.fillRect(bx, by, drawW, drawH);
        }

        if (!state.inArea) {
          ctx.strokeStyle = colorToCSS(state.color);
          ctx.strokeRect(bx, by, drawW, drawH);
        }
      }
      break;
    }

    case GOCADrawingOrderType.GARC: {
      // Arc: params = [cx_hi, cx_lo, cy_hi, cy_lo, radius_hi, radius_lo, start_angle, sweep]
      if (p.length >= 8) {
        const cx = offsetX + readInt16(p, 0) * sf;
        const cy = offsetY + readInt16(p, 2) * sf;
        const radius = Math.abs(readInt16(p, 4) * sf);
        const startAngle = p.length >= 7 ? (p[6] * Math.PI) / 180 : 0;
        const sweepAngle = p.length >= 8 ? (p[7] * Math.PI) / 180 : Math.PI * 2;

        ctx.strokeStyle = colorToCSS(state.color);
        ctx.lineWidth = state.lineWidth;
        applyLineType(ctx, state.lineType, state.lineWidth);

        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, startAngle + sweepAngle);
        ctx.stroke();
      }
      break;
    }

    case GOCADrawingOrderType.GFLT: {
      // Fillet (rounded corner): treat as lines through control points
      for (let i = 0; i + 3 < p.length; i += 4) {
        const x = offsetX + readInt16(p, i) * sf;
        const y = offsetY + readInt16(p, i + 2) * sf;

        if (i === 0) {
          ctx.beginPath();
          ctx.moveTo(offsetX + state.curX * sf, offsetY + state.curY * sf);
        }
        ctx.lineTo(x, y);

        state.curX = readInt16(p, i);
        state.curY = readInt16(p, i + 2);
      }
      ctx.strokeStyle = colorToCSS(state.color);
      ctx.lineWidth = state.lineWidth;
      ctx.stroke();
      break;
    }

    case GOCADrawingOrderType.GCBEZ: {
      // Bézier curve from current position.
      // Supports both formats:
      //   12 bytes/segment: cubic (cp1, cp2, endpoint) — 3 coordinate pairs
      //    8 bytes/segment: quadratic (cp, endpoint) — 2 coordinate pairs
      //    4 bytes/segment: line-to (endpoint) — 1 coordinate pair
      if (!state.inArea) {
        ctx.beginPath();
        ctx.moveTo(offsetX + state.curX * sf, offsetY + state.curY * sf);
      }

      let i = 0;
      while (i < p.length) {
        if (i + 11 < p.length) {
          // Cubic Bézier (12 bytes: cp1, cp2, endpoint)
          const cp1x = offsetX + readInt16(p, i) * sf;
          const cp1y = offsetY + readInt16(p, i + 2) * sf;
          const cp2x = offsetX + readInt16(p, i + 4) * sf;
          const cp2y = offsetY + readInt16(p, i + 6) * sf;
          const ex = offsetX + readInt16(p, i + 8) * sf;
          const ey = offsetY + readInt16(p, i + 10) * sf;
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
          state.curX = readInt16(p, i + 8);
          state.curY = readInt16(p, i + 10);
          i += 12;
        } else if (i + 7 < p.length) {
          // Quadratic Bézier (8 bytes: control point, endpoint)
          const cpx = offsetX + readInt16(p, i) * sf;
          const cpy = offsetY + readInt16(p, i + 2) * sf;
          const ex = offsetX + readInt16(p, i + 4) * sf;
          const ey = offsetY + readInt16(p, i + 6) * sf;
          ctx.quadraticCurveTo(cpx, cpy, ex, ey);
          state.curX = readInt16(p, i + 4);
          state.curY = readInt16(p, i + 6);
          i += 8;
        } else if (i + 3 < p.length) {
          // Line-to fallback (4 bytes: endpoint)
          const ex = offsetX + readInt16(p, i) * sf;
          const ey = offsetY + readInt16(p, i + 2) * sf;
          ctx.lineTo(ex, ey);
          state.curX = readInt16(p, i);
          state.curY = readInt16(p, i + 2);
          i += 4;
        } else {
          break;
        }
      }

      if (!state.inArea) {
        ctx.strokeStyle = colorToCSS(state.color);
        ctx.lineWidth = state.lineWidth;
        ctx.stroke();
      }
      break;
    }

    case GOCADrawingOrderType.GMRK:
    case GOCADrawingOrderType.GSMK: {
      // Marker: draw a small cross at the position
      if (p.length >= 4) {
        const mx = offsetX + readInt16(p, 0) * sf;
        const my = offsetY + readInt16(p, 2) * sf;
        const sz = 3;

        ctx.strokeStyle = colorToCSS(state.color);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx - sz, my);
        ctx.lineTo(mx + sz, my);
        ctx.moveTo(mx, my - sz);
        ctx.lineTo(mx, my + sz);
        ctx.stroke();
      }
      break;
    }
  }
}

/**
 * Renders a GOCA graphics object onto a 2D canvas context.
 *
 * @param ctx         - The canvas 2D rendering context.
 * @param gocaObj     - The parsed GOCA graphics object.
 * @param offsetX     - Horizontal pixel offset for the object's container position.
 * @param offsetY     - Vertical pixel offset for the object's container position.
 * @param scaleFactor - Combined DPI/zoom scale: (dpi / resolution) * zoom.
 */
export function renderGraphics(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  gocaObj: GOCAObject,
  offsetX: number,
  offsetY: number,
  scaleFactor: number,
): void {
  ctx.save();
  const state = defaultDrawState();

  // If the GOCA object has a coordinateScale (e.g., from IPS page segment),
  // the drawing orders use the segment's coordinate space which may differ
  // from the page's resolution. Multiply scaleFactor by coordinateScale
  // to convert segment units → page units → pixels.
  const effectiveSF = scaleFactor * (gocaObj.coordinateScale ?? 1);

  // Overlay GOCA uses Y-up coordinates (math convention) while canvas
  // uses Y-down. Apply vertical flip when flagged.
  if (gocaObj.flipX && gocaObj.bounds) {
    const h = gocaObj.bounds.height * effectiveSF;
    ctx.translate(0, offsetY + h);
    ctx.scale(1, -1);
    for (const order of gocaObj.orders) {
      processOrder(ctx, order, state, effectiveSF, offsetX, 0);
    }
  } else {
    for (const order of gocaObj.orders) {
      processOrder(ctx, order, state, effectiveSF, offsetX, offsetY);
    }
  }

  ctx.restore();
}
