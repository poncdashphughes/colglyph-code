/**
 * Camera capture preprocessing pipeline.
 *
 * Takes a raw camera frame and produces a clean, perspective-corrected
 * canvas ready for the standard decode pipeline.
 *
 * Steps:
 *   1. Detect the white glyph rectangle via bright-pixel edge scanning
 *   2. Refine the four corners
 *   3. Perspective warp to produce a fronto-parallel view
 *   4. White balance normalisation using the quiet zone
 */

interface Point { x: number; y: number }
interface Quad { tl: Point; tr: Point; bl: Point; br: Point }

/**
 * Full preprocessing pipeline: detect glyph, correct perspective, normalise colour.
 * Returns a new canvas containing the corrected image, or null if no glyph found.
 */
export function preprocessFrame(
  sourceCanvas: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const srcCtx = sourceCanvas.getContext('2d')!;
  const { width, height } = sourceCanvas;
  const imageData = srcCtx.getImageData(0, 0, width, height);

  const quad = findGlyphQuad(imageData, width, height);
  if (!quad) return null;

  const corrected = perspectiveWarp(sourceCanvas, quad);
  normaliseWhiteBalance(corrected.ctx, corrected.canvas.width, corrected.canvas.height, corrected.inset);

  return { canvas: corrected.canvas, ctx: corrected.ctx };
}

/**
 * Detect the glyph rectangle by scanning for the white quiet zone border.
 *
 * For each row, find the leftmost/rightmost bright pixel (>200).
 * The consistent left/right edges across rows define the glyph boundary.
 * Similarly for top/bottom via column scans.
 */
function findGlyphQuad(
  imageData: ImageData,
  width: number,
  height: number,
): Quad | null {
  const data = imageData.data;
  const BRIGHT = 200;

  // For each row, find left/right extent of bright pixels
  const rowLeft = new Int32Array(height).fill(-1);
  const rowRight = new Int32Array(height).fill(-1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const b = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (b > BRIGHT) {
        if (rowLeft[y] < 0) rowLeft[y] = x;
        rowRight[y] = x;
      }
    }
  }

  // For each column, find top/bottom extent of bright pixels
  const colTop = new Int32Array(width).fill(-1);
  const colBottom = new Int32Array(width).fill(-1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      const b = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (b > BRIGHT) {
        if (colTop[x] < 0) colTop[x] = y;
        colBottom[x] = y;
      }
    }
  }

  // Find vertical extent: rows that have a significant bright span (> 5% of width)
  const minSpan = width * 0.05;
  let topY = -1, bottomY = -1;
  for (let y = 0; y < height; y++) {
    if (rowLeft[y] >= 0 && (rowRight[y] - rowLeft[y]) > minSpan) {
      if (topY < 0) topY = y;
      bottomY = y;
    }
  }

  // Find horizontal extent: columns that have a significant bright span
  const minVSpan = height * 0.05;
  let leftX = -1, rightX = -1;
  for (let x = 0; x < width; x++) {
    if (colTop[x] >= 0 && (colBottom[x] - colTop[x]) > minVSpan) {
      if (leftX < 0) leftX = x;
      rightX = x;
    }
  }

  if (topY < 0 || bottomY < 0 || leftX < 0 || rightX < 0) return null;
  if ((rightX - leftX) < width * 0.1 || (bottomY - topY) < height * 0.1) return null;

  // Find the maximum row span — only use full-span rows for edge fitting
  let maxSpan = 0;
  for (let y = topY; y <= bottomY; y++) {
    const span = rowRight[y] - rowLeft[y];
    if (span > maxSpan) maxSpan = span;
  }
  const fullSpanThresh = maxSpan * 0.8;

  // Collect full-span rows
  let fullRows: number[] = [];
  for (let y = topY; y <= bottomY; y++) {
    if (rowLeft[y] >= 0 && (rowRight[y] - rowLeft[y]) >= fullSpanThresh) {
      fullRows.push(y);
    }
  }
  if (fullRows.length < 4) return null;
  // Rows near the rotated corners have asymmetrically shortened spans that
  // bias the edge fit — keep only the middle 70% for fitting
  const rowTrim = Math.floor(fullRows.length * 0.15);
  if (fullRows.length - 2 * rowTrim >= 4) {
    fullRows = fullRows.slice(rowTrim, fullRows.length - rowTrim);
  }

  // Similarly for columns
  let maxVSpan = 0;
  for (let x = leftX; x <= rightX; x++) {
    const span = colBottom[x] - colTop[x];
    if (span > maxVSpan) maxVSpan = span;
  }
  const fullVSpanThresh = maxVSpan * 0.8;
  let fullCols: number[] = [];
  for (let x = leftX; x <= rightX; x++) {
    if (colTop[x] >= 0 && (colBottom[x] - colTop[x]) >= fullVSpanThresh) {
      fullCols.push(x);
    }
  }
  if (fullCols.length < 4) return null;
  const colTrim = Math.floor(fullCols.length * 0.15);
  if (fullCols.length - 2 * colTrim >= 4) {
    fullCols = fullCols.slice(colTrim, fullCols.length - colTrim);
  }

  // Fit four edge lines from the full-span data:
  // Left edge:  x = f(y) from rowLeft of full rows
  // Right edge: x = f(y) from rowRight of full rows
  // Top edge:   y = f(x) from colTop of full cols
  // Bottom edge: y = f(x) from colBottom of full cols
  const leftLine = fitEdgeLine(fullRows, y => rowLeft[y]);   // x = f(y)
  const rightLine = fitEdgeLine(fullRows, y => rowRight[y]);  // x = f(y)
  const topLine = fitEdgeLine(fullCols, x => colTop[x]);      // y = f(x)
  const bottomLine = fitEdgeLine(fullCols, x => colBottom[x]); // y = f(x)

  // Find corners as intersections of edge lines
  // TL: intersection of left edge (x=f(y)) and top edge (y=g(x))
  // Solve: x = leftLine(y), y = topLine(x) → iterate
  const tl = intersectEdges(leftLine, topLine);
  const tr = intersectEdges(rightLine, topLine);
  const bl = intersectEdges(leftLine, bottomLine);
  const br = intersectEdges(rightLine, bottomLine);

  if (!tl || !tr || !bl || !br) return null;

  return { tl, tr, bl, br };
}

/** Find the intersection of two edge lines via fixed-point iteration.
 *  xLine: x = f(y), yLine: y = g(x)
 */
function intersectEdges(
  xLine: { predict: (y: number) => number },
  yLine: { predict: (x: number) => number },
): Point | null {
  // Start with a rough estimate and iterate
  let x = xLine.predict(0);
  let y = yLine.predict(x);

  for (let i = 0; i < 20; i++) {
    const newX = xLine.predict(y);
    const newY = yLine.predict(newX);
    if (Math.abs(newX - x) < 0.5 && Math.abs(newY - y) < 0.5) {
      return { x: newX, y: newY };
    }
    x = newX;
    y = newY;
  }

  return { x, y };
}

/** Fit a simple linear regression to edge positions and return a predictor */
function fitEdgeLine(
  ys: number[],
  getX: (y: number) => number,
): { predict: (y: number) => number } {
  const n = ys.length;
  let sumY = 0, sumX = 0, sumYY = 0, sumYX = 0;
  for (const y of ys) {
    const x = getX(y);
    sumY += y;
    sumX += x;
    sumYY += y * y;
    sumYX += y * x;
  }
  const denom = n * sumYY - sumY * sumY;
  if (Math.abs(denom) < 1e-6) {
    // Vertical line — constant x
    const avgX = sumX / n;
    return { predict: () => avgX };
  }
  const slope = (n * sumYX - sumY * sumX) / denom;
  const intercept = (sumX - slope * sumY) / n;
  return { predict: (y: number) => slope * y + intercept };
}

/**
 * Apply a perspective warp to extract the glyph region as a rectangle.
 * Uses bilinear interpolation from the source quad to a rectangular output.
 */
function perspectiveWarp(
  source: HTMLCanvasElement,
  quad: Quad,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; inset: number } {
  const topWidth = Math.sqrt((quad.tr.x - quad.tl.x) ** 2 + (quad.tr.y - quad.tl.y) ** 2);
  const bottomWidth = Math.sqrt((quad.br.x - quad.bl.x) ** 2 + (quad.br.y - quad.bl.y) ** 2);
  const leftHeight = Math.sqrt((quad.bl.x - quad.tl.x) ** 2 + (quad.bl.y - quad.tl.y) ** 2);
  const rightHeight = Math.sqrt((quad.br.x - quad.tr.x) ** 2 + (quad.br.y - quad.tr.y) ** 2);

  const innerW = Math.round(Math.max(topWidth, bottomWidth));
  const innerH = Math.round(Math.max(leftHeight, rightHeight));

  // Add a generous white border so edge artifacts don't touch content bounds.
  const border = Math.max(8, Math.round(Math.min(innerW, innerH) * 0.03));
  const outW = innerW + border * 2;
  const outH = innerH + border * 2;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;

  // Fill with white (the border)
  outCtx.fillStyle = '#FFFFFF';
  outCtx.fillRect(0, 0, outW, outH);

  const srcCtx = source.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, source.width, source.height);
  const outData = outCtx.getImageData(0, 0, outW, outH);

  for (let oy = border; oy < border + innerH; oy++) {
    const v = innerH > 1 ? (oy - border) / (innerH - 1) : 0;

    const leftX = quad.tl.x + v * (quad.bl.x - quad.tl.x);
    const leftY = quad.tl.y + v * (quad.bl.y - quad.tl.y);
    const rightX = quad.tr.x + v * (quad.br.x - quad.tr.x);
    const rightY = quad.tr.y + v * (quad.br.y - quad.tr.y);

    for (let ox = border; ox < border + innerW; ox++) {
      const u = innerW > 1 ? (ox - border) / (innerW - 1) : 0;

      const sx = leftX + u * (rightX - leftX);
      const sy = leftY + u * (rightY - leftY);

      const px = Math.floor(sx);
      const py = Math.floor(sy);
      const fx = sx - px;
      const fy = sy - py;

      const oi = (oy * outW + ox) * 4;

      if (px < 0 || px >= source.width - 1 || py < 0 || py >= source.height - 1) {
        outData.data[oi] = 255;
        outData.data[oi + 1] = 255;
        outData.data[oi + 2] = 255;
        outData.data[oi + 3] = 255;
        continue;
      }

      const i00 = (py * source.width + px) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + source.width * 4;
      const i11 = i01 + 4;

      for (let c = 0; c < 3; c++) {
        const v00 = srcData.data[i00 + c];
        const v10 = srcData.data[i10 + c];
        const v01 = srcData.data[i01 + c];
        const v11 = srcData.data[i11 + c];
        outData.data[oi + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) +
          v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy +
          v11 * fx * fy
        );
      }
      outData.data[oi + 3] = 255;
    }
  }

  // Clean up edge artifacts: bilinear interpolation at rotated quad corners/edges
  // blends white quiet zone with dark background, creating grey pixels that
  // confuse findContentBounds. Replace dark pixels near the warped area edges with white.
  const cleanMargin = Math.max(8, Math.round(Math.min(innerW, innerH) * 0.02));
  for (let oy = border; oy < border + innerH; oy++) {
    for (let ox = border; ox < border + innerW; ox++) {
      const edgeDist = Math.min(
        ox - border, border + innerW - 1 - ox,
        oy - border, border + innerH - 1 - oy
      );
      if (edgeDist >= cleanMargin) continue;
      const oi = (oy * outW + ox) * 4;
      // If this edge pixel isn't pure white, replace with white.
      // Edge pixels can have dark background bleed-through from bilinear interpolation
      // at the rotated quad boundary. Use a generous threshold since quiet zone should be white.
      const r = outData.data[oi], g = outData.data[oi + 1], b = outData.data[oi + 2];
      if (r < 250 || g < 250 || b < 250) {
        outData.data[oi] = 255;
        outData.data[oi + 1] = 255;
        outData.data[oi + 2] = 255;
      }
    }
  }

  outCtx.putImageData(outData, 0, 0);
  // inset = everything the warp painted or scrubbed to pure white; the
  // glyph's real quiet zone starts beyond it.
  return { canvas: outCanvas, ctx: outCtx, inset: border + cleanMargin };
}

/**
 * Normalise white balance using the quiet zone.
 * Samples the border pixels (which should be white) and adjusts
 * all channels so those pixels map to 255.
 */
function normaliseWhiteBalance(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  inset: number,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Sample the ring between the warp's synthetic white border (inset)
  // and the outer 10% band: that is the glyph's real quiet zone. The
  // ring is chosen geometrically and pure-white pixels are NOT skipped —
  // a well-exposed or clipped quiet zone legitimately reads 255, and
  // skipping it used to leave only anti-aliased cell edges to "correct"
  // against, applying a bogus ~1.3× gain that failed every decode of a
  // bright screen.
  const margin = Math.max(inset + 8, Math.round(Math.min(width, height) * 0.10));
  let sumR = 0, sumG = 0, sumB = 0, count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = Math.min(x, width - 1 - x, y, height - 1 - y);
      if (edge < inset || edge >= margin) continue;
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], bl = data[i + 2];
      // Only sample bright, near-grey pixels: the quiet zone under a colour
      // cast. Strongly saturated pixels are glyph cells, not quiet zone.
      const b = 0.299 * r + 0.587 * g + 0.114 * bl;
      const spread = Math.max(r, g, bl) - Math.min(r, g, bl);
      if (b > 150 && spread < 60) {
        sumR += r;
        sumG += g;
        sumB += bl;
        count++;
      }
    }
  }

  if (count < 10) return;

  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;

  const avgBrightness = (avgR + avgG + avgB) / 3;
  if (avgBrightness < 150) return;

  const maxDiff = Math.max(
    Math.abs(avgR - 255),
    Math.abs(avgG - 255),
    Math.abs(avgB - 255),
  );
  if (maxDiff < 10) return;

  const scaleR = 255 / avgR;
  const scaleG = 255 / avgG;
  const scaleB = 255 / avgB;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, Math.round(data[i] * scaleR));
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * scaleG));
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * scaleB));
  }

  ctx.putImageData(imageData, 0, 0);
}
