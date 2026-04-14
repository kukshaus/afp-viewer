/**
 * Page Compositor
 *
 * Orchestrates the rendering of a complete AFP page by dispatching each
 * PageObject in the render tree to its appropriate sub-architecture renderer
 * (PTOCA text, IOCA image, GOCA graphics, BCOCA barcode).
 *
 * Supports both browser (HTMLCanvasElement) and worker (OffscreenCanvas)
 * environments. The output canvas is sized according to the page dimensions,
 * target DPI, and zoom level.
 */

import type { PageRenderTree, PageObject } from '@/lib/afp/types';
import { renderText } from '@/lib/ptoca/renderer';
import { renderGraphics } from '@/lib/goca/renderer';
import { renderBarcode } from '@/lib/bcoca/renderer';
import { decodeIOCAImage } from '@/lib/ioca/decoder';
import { IOCACompression } from '@/lib/afp/types';

// ---------------------------------------------------------------------------
// Canvas creation helpers
// ---------------------------------------------------------------------------

/**
 * Creates a canvas of the specified dimensions, preferring OffscreenCanvas in
 * worker environments and falling back to HTMLCanvasElement in the browser.
 */
function createCanvas(
  widthPx: number,
  heightPx: number,
): HTMLCanvasElement | OffscreenCanvas {
  // Clamp dimensions to reasonable limits to prevent memory issues
  const clampedWidth = Math.max(1, Math.min(widthPx, 16384));
  const clampedHeight = Math.max(1, Math.min(heightPx, 16384));

  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(clampedWidth, clampedHeight);
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = clampedWidth;
    canvas.height = clampedHeight;
    return canvas;
  }

  // Fallback for environments with neither (e.g., node-canvas would need
  // to be handled separately). Throw a descriptive error.
  throw new Error(
    'No canvas implementation available. ' +
    'Ensure this code runs in a browser or a worker with OffscreenCanvas support.',
  );
}

/**
 * Gets a 2D rendering context from a canvas, supporting both
 * HTMLCanvasElement and OffscreenCanvas.
 */
function get2DContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to obtain 2D rendering context from canvas.');
  }
  return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a full page from a PageRenderTree onto a canvas.
 *
 * The canvas is sized to match the page dimensions at the specified DPI and
 * zoom level. Each object in the render tree is drawn in document order.
 *
 * @param tree  The page render tree produced by the page parser.
 * @param dpi   Target rendering resolution in dots per inch (default 150).
 * @param zoom  Zoom multiplier (default 1.0).
 * @returns A canvas element (HTMLCanvasElement or OffscreenCanvas) containing
 *          the rendered page.
 */
export async function renderPage(
  tree: PageRenderTree,
  dpi: number = 150,
  zoom: number = 1.0,
  showPlaceholders: boolean = true,
): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const resolution = tree.resolution > 0 ? tree.resolution : 1440;

  // Calculate pixel dimensions
  // pixels = (L-units / resolution) * dpi * zoom
  const widthPx = Math.round((tree.width / resolution) * dpi * zoom);
  const heightPx = Math.round((tree.height / resolution) * dpi * zoom);

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = get2DContext(canvas);

  // Fill white background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Clip to page bounds — content outside the page (e.g. from overlays
  // with large offsets) should not be visible
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, widthPx, heightPx);
  ctx.clip();

  // Compute the scale factor that converts L-units to pixels
  const scaleFactor = (dpi / resolution) * zoom;

  // Render each object in document order
  for (const obj of tree.objects) {
    try {
      await renderObject(ctx, obj, scaleFactor, dpi, showPlaceholders);
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(
          `Compositor: error rendering ${obj.kind} object at (${obj.x}, ${obj.y}):`,
          err,
        );
      }
      // Draw a placeholder for failed objects so users know something is there
      if (showPlaceholders) drawPlaceholder(ctx, obj, scaleFactor);
    }
  }

  ctx.restore(); // restore clip region

  // Return as HTMLCanvasElement for type compatibility — OffscreenCanvas is
  // a subtype-compatible shape in practice, and callers that need strict
  // typing can cast.
  return canvas as HTMLCanvasElement;
}

/**
 * Renders a thumbnail of a page, scaled to fit within maxWidth x maxHeight.
 *
 * Uses a low DPI (36) for fast rendering, then scales the result to fit the
 * requested thumbnail bounds while maintaining the page aspect ratio.
 *
 * @param tree      The page render tree.
 * @param maxWidth  Maximum thumbnail width in pixels (default 120).
 * @param maxHeight Maximum thumbnail height in pixels (default 170).
 * @returns A canvas element containing the thumbnail.
 */
export async function renderThumbnail(
  tree: PageRenderTree,
  maxWidth: number = 120,
  maxHeight: number = 170,
): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const resolution = tree.resolution > 0 ? tree.resolution : 1440;

  // Render at low DPI for speed
  const thumbnailDpi = 36;
  const rawWidthPx = Math.round((tree.width / resolution) * thumbnailDpi);
  const rawHeightPx = Math.round((tree.height / resolution) * thumbnailDpi);

  // Determine the scale needed to fit within maxWidth x maxHeight
  const scaleX = maxWidth / Math.max(1, rawWidthPx);
  const scaleY = maxHeight / Math.max(1, rawHeightPx);
  const scale = Math.min(scaleX, scaleY, 1.0); // never upscale beyond 1:1

  const finalWidth = Math.max(1, Math.round(rawWidthPx * scale));
  const finalHeight = Math.max(1, Math.round(rawHeightPx * scale));

  // If scaling is close to 1:1, render directly at the target size
  if (Math.abs(scale - 1.0) < 0.01) {
    return await renderPage(tree, thumbnailDpi, 1.0);
  }

  // Render the full page at low DPI
  const fullCanvas = await renderPage(tree, thumbnailDpi, 1.0);

  // Create the thumbnail canvas and draw the scaled image
  const thumbCanvas = createCanvas(finalWidth, finalHeight);
  const thumbCtx = get2DContext(thumbCanvas);

  // Fill white background for the thumbnail
  thumbCtx.fillStyle = '#FFFFFF';
  thumbCtx.fillRect(0, 0, finalWidth, finalHeight);

  // Enable image smoothing for cleaner downscale
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.imageSmoothingQuality = 'medium';

  // Draw the full render scaled down into the thumbnail
  thumbCtx.drawImage(
    fullCanvas as CanvasImageSource,
    0,
    0,
    fullCanvas.width,
    fullCanvas.height,
    0,
    0,
    finalWidth,
    finalHeight,
  );

  return thumbCanvas as HTMLCanvasElement;
}

// ---------------------------------------------------------------------------
// Object renderer dispatcher
// ---------------------------------------------------------------------------

/**
 * Renders a single PageObject onto the canvas at its positioned location.
 */
async function renderObject(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  obj: PageObject,
  scaleFactor: number,
  renderDpi: number,
  showPlaceholders: boolean = true,
): Promise<void> {
  const pixelX = obj.x * scaleFactor;
  const pixelY = obj.y * scaleFactor;

  switch (obj.kind) {
    case 'text': {
      if (obj.text) {
        renderText(ctx, obj.text, 0, 0, scaleFactor, renderDpi);
      }
      break;
    }

    case 'image': {
      // Check for pre-rendered data URL (from IM Image parser)
      const dataUrl = (obj as PageObject & { _dataUrl?: string })._dataUrl;
      if (dataUrl && typeof window !== 'undefined') {
        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = reject;
            el.src = dataUrl;
          });
          const destX = Math.round(pixelX);
          const destY = Math.round(pixelY);
          const destW = Math.max(1, Math.round(obj.width * scaleFactor));
          const destH = Math.max(1, Math.round(obj.height * scaleFactor));
          ctx.drawImage(img, destX, destY, destW, destH);
        } catch {
          // Image data URL failed to decode — draw placeholder
          if (showPlaceholders) drawPlaceholder(ctx, obj, scaleFactor);
        }
      } else if (obj.image) {
        await renderImageObject(ctx, obj, scaleFactor);
      }
      break;
    }

    case 'graphics': {
      if (obj.graphics) {
        renderGraphics(ctx, obj.graphics, pixelX, pixelY, scaleFactor);
      }
      break;
    }

    case 'barcode': {
      if (obj.barcode) {
        renderBarcode(ctx, obj.barcode, pixelX, pixelY, scaleFactor);
      }
      break;
    }
  }
}

/**
 * Draws a visual placeholder for objects that failed to render.
 * Shows a dashed border with the object type label so users know
 * something should be there.
 */
function drawPlaceholder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  obj: PageObject,
  scaleFactor: number,
): void {
  const px = Math.round(obj.x * scaleFactor);
  const py = Math.round(obj.y * scaleFactor);
  const pw = Math.max(20, Math.round(obj.width * scaleFactor));
  const ph = Math.max(20, Math.round(obj.height * scaleFactor));

  ctx.save();
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
  ctx.setLineDash([]);

  // Label
  const label = obj.kind === 'image' ? 'IMG' : obj.kind === 'graphics' ? 'GFX' : obj.kind.toUpperCase();
  ctx.fillStyle = '#bbb';
  ctx.font = '9px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(label, px + pw / 2, py + ph / 2 + 3);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Image rendering
// ---------------------------------------------------------------------------

/**
 * Decodes and renders an IOCA image object onto the canvas.
 *
 * The image is decoded from its AFP-native format (potentially CCITT G4,
 * JPEG, or uncompressed) into RGBA pixel data, then placed on the canvas
 * at the object's position.
 */
async function renderImageObject(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  obj: PageObject,
  scaleFactor: number,
): Promise<void> {
  const image = obj.image!;

  // For JPEG: draw using async Image loading
  if (image.compression === IOCACompression.JPEG && image.data.length > 2 &&
      image.data[0] === 0xFF && image.data[1] === 0xD8) {
    await renderJpegImage(ctx, obj, image, scaleFactor);
    return;
  }

  const decoded = decodeIOCAImage(image);

  if (decoded.width === 0 || decoded.height === 0) return;

  const rgbaBuffer = new Uint8ClampedArray(decoded.data.length);
  rgbaBuffer.set(decoded.data);
  const imageData = new ImageData(rgbaBuffer, decoded.width, decoded.height);

  // Calculate the destination position and size in pixels
  const destX = Math.round(obj.x * scaleFactor);
  const destY = Math.round(obj.y * scaleFactor);

  // Calculate the destination size based on the image resolution and page
  // resolution. The image has its own resolution (dots per unit); we need
  // to scale it to match the page coordinate space.
  const imgResX = image.xResolution > 0 ? image.xResolution : 1440;
  const imgResY = image.yResolution > 0 ? image.yResolution : 1440;

  // Each image pixel corresponds to 1/imgRes inches of physical space.
  // The scaleFactor converts L-units (at the page resolution, typically
  // 1440/inch) to output pixels.  So the destination size in output
  // pixels is:
  //   destPx = (imagePels / imgRes) * outputDpi * zoom
  //          = imagePels * (scaleFactor * pageRes / imgRes)
  // Since scaleFactor = (dpi / pageRes) * zoom, this simplifies to:
  //   destPx = imagePels * dpi * zoom / imgRes
  //          = imagePels * scaleFactor * (pageRes / imgRes)
  // where pageRes = 1440 by default.
  const pageRes = 1440;
  const destWidth = Math.max(1, Math.round(decoded.width * scaleFactor * (pageRes / imgResX)));
  const destHeight = Math.max(1, Math.round(decoded.height * scaleFactor * (pageRes / imgResY)));

  // For simple cases where the image fits exactly at its decoded size,
  // use putImageData (no scaling). For cases requiring scaling, we need
  // a temporary canvas.
  const needsScaling =
    Math.abs(destWidth - decoded.width) > 1 ||
    Math.abs(destHeight - decoded.height) > 1;

  if (needsScaling) {
    // Create a temporary canvas with the decoded image, then drawImage
    // to scale it to the destination size.
    const tmpCanvas = createCanvas(decoded.width, decoded.height);
    const tmpCtx = get2DContext(tmpCanvas);
    tmpCtx.putImageData(imageData, 0, 0);

    ctx.drawImage(
      tmpCanvas as CanvasImageSource,
      0,
      0,
      decoded.width,
      decoded.height,
      destX,
      destY,
      Math.max(1, destWidth),
      Math.max(1, destHeight),
    );
  } else {
    // Direct placement — fastest path
    ctx.putImageData(imageData, destX, destY);
  }
}

/**
 * Renders a JPEG image by creating a temporary canvas from the raw JPEG data.
 * Since we can't use async createImageBitmap in a synchronous render pipeline,
 * we encode the JPEG as a data URL and draw it synchronously via a hidden Image.
 * If that fails, we fall back to drawing a placeholder.
 */
async function renderJpegImage(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  obj: PageObject,
  image: PageObject['image'] & object,
  scaleFactor: number,
): Promise<void> {
  const destX = Math.round(obj.x * scaleFactor);
  const destY = Math.round(obj.y * scaleFactor);
  const destWidth = Math.max(1, Math.round(obj.width * scaleFactor));
  const destHeight = Math.max(1, Math.round(obj.height * scaleFactor));

  try {
    if (typeof window !== 'undefined') {
      // Convert JPEG bytes to base64 data URL
      let base64 = '';
      const bytes = image.data;
      for (let i = 0; i < bytes.length; i++) {
        base64 += String.fromCharCode(bytes[i]);
      }
      const dataUrl = 'data:image/jpeg;base64,' + btoa(base64);

      // Load the image and wait for it
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });

      ctx.drawImage(img, destX, destY, destWidth, destHeight);
    }
  } catch {
    // Fallback placeholder
    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth = 1;
    ctx.strokeRect(destX, destY, destWidth, destHeight);
    ctx.fillStyle = '#F0F0F0';
    ctx.fillRect(destX + 1, destY + 1, destWidth - 2, destHeight - 2);
    ctx.fillStyle = '#999999';
    ctx.font = '10px Arial';
    ctx.fillText('[Image]', destX + 4, destY + 14);
  }
}
