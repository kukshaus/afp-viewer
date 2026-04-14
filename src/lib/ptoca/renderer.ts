/**
 * PTOCA Text Renderer
 *
 * Draws PTOCATextObject runs onto a CanvasRenderingContext2D or
 * OffscreenCanvasRenderingContext2D. Each TextRun is positioned at its
 * pre-computed pixel coordinates and rendered with the appropriate font
 * style and colour.
 */

import type { PTOCATextObject, AFPColor, TextRun } from '@/lib/afp/types';

/**
 * Converts an AFPColor to a CSS rgba() string.
 */
function colorToCSS(c: AFPColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
}

/**
 * Maps an AFP font ID to a CSS font-family string.
 * Most AFP documents use proportional fonts (Arial/Helvetica-style).
 */
function fontFamilyForId(_fontId: number): string {
  return '"DejaVu Sans Condensed", "DejaVu Sans", Arial, Helvetica, sans-serif';
}

/**
 * Builds a CSS font shorthand for a single text run.
 *
 * Font size is in points. Convert to pixels at the given render DPI:
 * sizePx = points * (renderDpi / 72)
 */
function cssFontForRun(run: TextRun, renderDpi: number): string {
  const sizePx = Math.max(4, Math.round(run.fontSize * (renderDpi / 72) * 0.92));
  const weight = run.bold ? 'bold' : 'normal';
  return `${weight} ${sizePx}px ${fontFamilyForId(run.fontId)}`;
}

/**
 * Renders a PTOCA text object onto a 2D canvas context.
 *
 * @param ctx         - The canvas 2D rendering context to draw on.
 * @param textObj     - The parsed PTOCA text object containing text runs.
 * @param offsetX     - Horizontal pixel offset for the object's container position.
 * @param offsetY     - Vertical pixel offset for the object's container position.
 * @param scaleFactor - Combined DPI/zoom scale: (dpi / resolution) * zoom.
 */
export function renderText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  textObj: PTOCATextObject,
  offsetX: number,
  offsetY: number,
  scaleFactor: number,
  renderDpi: number = 150,
): void {
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  for (const run of textObj.runs) {
    if (run.text.length === 0) continue;

    const px = offsetX + run.x * scaleFactor;
    const py = offsetY + run.y * scaleFactor;

    ctx.fillStyle = colorToCSS(run.color);
    ctx.font = cssFontForRun(run, renderDpi);

    if (run.orientation === 0) {
      ctx.fillText(run.text, px, py);
      if (run.underline) {
        const metrics = ctx.measureText(run.text);
        ctx.beginPath();
        ctx.strokeStyle = colorToCSS(run.color);
        ctx.lineWidth = Math.max(1, Math.round(run.fontSize * 0.07 * (renderDpi / 72)));
        ctx.moveTo(px, py + 2);
        ctx.lineTo(px + metrics.width, py + 2);
        ctx.stroke();
      }
    } else {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((run.orientation * Math.PI) / 180);
      ctx.fillText(run.text, 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();
}
