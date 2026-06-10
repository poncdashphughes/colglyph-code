import type { GlyphLayout } from '../core/types';
import type { PageMeta } from '../core/binary';
import { PALETTE } from '../core/palette';
import { bytesToNibbles } from '../core/binary';

/** Orientation square colours — fixed, used for visual identification */
const ORIENT_COLOURS = {
  magic:    '#D92626',  // Red — always active, identifies a ColGlyph
  page:     '#E87D1A',  // Orange — page info
  size:     '#2E6FBF',  // Blue — file size
  cols:     '#2B7A78',  // Teal — grid columns
  rows:     '#5B4A9E',  // Indigo — grid rows
  ext:      '#7D3DAD',  // Purple — file extension
  check:    '#1A8C5A',  // Green — integrity
  inactive: '#D0D0D0',
};

interface InfoSquare {
  col: number;
  row: number;
  colour: string;
  text: string;
  active: boolean;
}

function buildInfoSquares(meta: PageMeta | null): InfoSquare[] {
  return [
    // Top row
    { col: 0, row: 0, colour: ORIENT_COLOURS.page, text: meta ? `P${meta.page + 1}/${meta.totalPages}` : 'P-', active: !!meta },
    { col: 1, row: 0, colour: ORIENT_COLOURS.size, text: meta ? formatBytesShort(meta.fileSize) : '-', active: !!meta && meta.fileSize > 0 },
    { col: 2, row: 0, colour: ORIENT_COLOURS.cols, text: meta ? `C${meta.cols}` : 'C-', active: !!meta },
    // Bottom row
    { col: 0, row: 1, colour: ORIENT_COLOURS.ext, text: meta?.extension ? `.${meta.extension}` : 'FILE', active: !!meta },
    { col: 1, row: 1, colour: ORIENT_COLOURS.check, text: meta?.compressed ? 'ZIP' : 'ECC', active: !!meta },
    { col: 2, row: 1, colour: ORIENT_COLOURS.rows, text: meta ? `R${meta.rows}` : 'R-', active: !!meta },
  ];
}

/** Cell rendering geometry shared by canvas and SVG paths */
function cellGeometry(cellSize: number): { gap: number; radius: number } {
  return {
    gap: cellSize < 10 ? 0.25 : Math.max(0.5, cellSize * 0.04),
    radius: cellSize < 10 ? 0 : Math.max(1, cellSize * 0.1),
  };
}

/**
 * Render a ColGlyph data page onto a canvas.
 * Draws the orientation zone (identity, page info, grid dimensions,
 * optional label) and the data grid. The label lives in the orientation
 * strip — never over data cells, which must stay clean for decoding.
 */
export function renderGlyph(
  canvas: HTMLCanvasElement,
  pageBytes: number[],
  meta: PageMeta | null,
  layout: GlyphLayout,
  label?: string,
): { nibbles: number[] } {
  const ctx = canvas.getContext('2d')!;
  const L = layout;

  canvas.width = L.canvasWidth;
  canvas.height = L.canvasHeight;

  // White background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawOrientationZone(ctx, L, meta, label);

  // ── Data Grid ──
  const nibbles = bytesToNibbles(pageBytes);

  // Pad to fill entire grid
  while (nibbles.length < L.capacityCells) {
    nibbles.push(14); // silver for unused cells
  }

  for (let row = 0; row < L.rows; row++) {
    for (let col = 0; col < L.cols; col++) {
      const idx = row * L.cols + col;
      const colorIdx = idx < nibbles.length ? nibbles[idx] : 14;

      const x = L.dataZoneX + col * L.cellSize;
      const y = L.dataZoneY + row * L.cellSize;
      const { gap, radius } = cellGeometry(L.cellSize);

      ctx.fillStyle = PALETTE[colorIdx].hex;
      ctx.beginPath();
      if (radius > 0) {
        ctx.roundRect(x + gap, y + gap, L.cellSize - gap * 2, L.cellSize - gap * 2, radius);
      } else {
        ctx.rect(x + gap, y + gap, L.cellSize - gap * 2, L.cellSize - gap * 2);
      }
      ctx.fill();
    }
  }

  return { nibbles };
}

function drawOrientationZone(
  ctx: CanvasRenderingContext2D,
  L: GlyphLayout,
  meta: PageMeta | null,
  label?: string,
) {
  const hzX = L.orientX;
  const hzY = L.orientY;
  const bigR = Math.max(2, L.orientSize * 0.07);
  const smallR = Math.max(1, L.orientSmallSize * 0.07);
  const isValid = meta !== null;

  // S0: Large square (top-left) — Magic/ColGlyph identifier
  ctx.fillStyle = isValid ? ORIENT_COLOURS.magic : ORIENT_COLOURS.inactive;
  ctx.beginPath();
  ctx.roundRect(hzX, hzY, L.orientSize - 2, L.orientSize - 2, bigR);
  ctx.fill();
  // Label
  ctx.fillStyle = isValid ? '#FFFFFF' : '#888888';
  ctx.font = `bold ${L.orientSize * 0.2}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isValid ? 'CG' : '--', hzX + L.orientSize / 2 - 1, hzY + L.orientSize / 2 - 1);

  // S1-S6: 3x2 grid to the right of S0
  const gridStartX = hzX + L.orientSize;
  buildInfoSquares(meta).forEach(s => {
    const sx = gridStartX + s.col * L.orientSmallSize;
    const sy = hzY + s.row * L.orientSmallSize;
    ctx.fillStyle = s.active ? s.colour : ORIENT_COLOURS.inactive;
    ctx.beginPath();
    ctx.roundRect(sx, sy, L.orientSmallSize - 2, L.orientSmallSize - 2, smallR);
    ctx.fill();

    ctx.fillStyle = s.active ? '#FFFFFF' : '#888888';
    const fontSize = Math.max(6, L.orientSmallSize * 0.25);
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, sx + L.orientSmallSize / 2 - 1, sy + L.orientSmallSize / 2 - 1);
  });

  // Dual-colour dimension squares — column 1 holds the low bytes of
  // cols/rows, column 2 the high bytes (grids can exceed 255 cells/side)
  const dimStartX = gridStartX + 3 * L.orientSmallSize;
  const cols = meta?.cols ?? 0;
  const rows = meta?.rows ?? 0;
  drawDualColorSquare(ctx, dimStartX, hzY, L.orientSmallSize, smallR, cols & 0xFF, isValid);
  drawDualColorSquare(ctx, dimStartX, hzY + L.orientSmallSize, L.orientSmallSize, smallR, rows & 0xFF, isValid);
  drawDualColorSquare(ctx, dimStartX + L.orientSmallSize, hzY, L.orientSmallSize, smallR, (cols >> 8) & 0xFF, isValid);
  drawDualColorSquare(ctx, dimStartX + L.orientSmallSize, hzY + L.orientSmallSize, L.orientSmallSize, smallR, (rows >> 8) & 0xFF, isValid);

  // Optional label — drawn in the orientation strip, clamped so it never
  // extends past the data grid's right edge (content-bounds alignment
  // in the decoder depends on the grid being the widest element)
  if (label) {
    const labelX = dimStartX + 2 * L.orientSmallSize + Math.max(4, L.orientSize * 0.15);
    const maxX = L.dataZoneX + L.cols * L.cellSize - L.cellSize;
    if (maxX > labelX + 10) {
      const fontSize = Math.max(7, L.orientSize * 0.3);
      ctx.fillStyle = '#1A1A1A';
      ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let text = label;
      while (text.length > 1 && ctx.measureText(text).width > maxX - labelX) {
        text = text.substring(0, text.length - 2) + '…';
      }
      if (ctx.measureText(text).width <= maxX - labelX) {
        ctx.fillText(text, labelX, hzY + L.orientHeight / 2);
      }
    }
  }
}

/** Draw a square split into top/bottom halves, each coloured by a palette nibble */
function drawDualColorSquare(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  radius: number,
  value: number,
  active: boolean,
) {
  const highNibble = (value >> 4) & 0x0F;
  const lowNibble = value & 0x0F;
  const halfH = (size - 2) / 2;

  // Top half — high nibble
  ctx.fillStyle = active ? PALETTE[highNibble].hex : ORIENT_COLOURS.inactive;
  ctx.beginPath();
  ctx.roundRect(x, y, size - 2, halfH, [radius, radius, 0, 0]);
  ctx.fill();

  // Bottom half — low nibble
  ctx.fillStyle = active ? PALETTE[lowNibble].hex : ORIENT_COLOURS.inactive;
  ctx.beginPath();
  ctx.roundRect(x, y + halfH, size - 2, halfH, [0, 0, radius, radius]);
  ctx.fill();
}

function formatBytesShort(bytes: number): string {
  if (bytes === 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Export glyph as SVG string */
export function renderGlyphSVG(
  pageBytes: number[],
  meta: PageMeta | null,
  layout: GlyphLayout,
  label?: string,
): string {
  const L = layout;
  const nibbles = bytesToNibbles(pageBytes);

  while (nibbles.length < L.capacityCells) {
    nibbles.push(14);
  }

  const isValid = meta !== null;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L.canvasWidth}" height="${L.canvasHeight}" viewBox="0 0 ${L.canvasWidth} ${L.canvasHeight}">`;
  svg += `<rect width="${L.canvasWidth}" height="${L.canvasHeight}" fill="#FFFFFF"/>`;

  // Orientation zone
  const hzX = L.orientX;
  const hzY = L.orientY;
  const bigR = Math.max(2, L.orientSize * 0.07);
  const smallR = Math.max(1, L.orientSmallSize * 0.07);

  // S0: Large magic square
  svg += `<rect x="${hzX}" y="${hzY}" width="${L.orientSize - 2}" height="${L.orientSize - 2}" rx="${bigR}" fill="${isValid ? ORIENT_COLOURS.magic : ORIENT_COLOURS.inactive}"/>`;
  svg += `<text x="${hzX + L.orientSize / 2 - 1}" y="${hzY + L.orientSize / 2}" text-anchor="middle" dominant-baseline="central" fill="${isValid ? '#FFF' : '#888'}" font-size="${L.orientSize * 0.2}" font-weight="bold" font-family="sans-serif">${isValid ? 'CG' : '--'}</text>`;

  // S1-S6: 3x2 info grid
  const gridStartX = hzX + L.orientSize;
  buildInfoSquares(meta).forEach(s => {
    const sx = gridStartX + s.col * L.orientSmallSize;
    const sy = hzY + s.row * L.orientSmallSize;
    svg += `<rect x="${sx}" y="${sy}" width="${L.orientSmallSize - 2}" height="${L.orientSmallSize - 2}" rx="${smallR}" fill="${s.active ? s.colour : ORIENT_COLOURS.inactive}"/>`;
    const fontSize = Math.max(6, L.orientSmallSize * 0.25);
    svg += `<text x="${sx + L.orientSmallSize / 2 - 1}" y="${sy + L.orientSmallSize / 2}" text-anchor="middle" dominant-baseline="central" fill="${s.active ? '#FFF' : '#888'}" font-size="${fontSize}" font-weight="bold" font-family="sans-serif">${s.text}</text>`;
  });

  // Dual-colour dimension squares (low-byte column, then high-byte column)
  const dimStartX = gridStartX + 3 * L.orientSmallSize;
  const cols = meta?.cols ?? 0;
  const rows = meta?.rows ?? 0;
  svg += dualColorSquareSVG(dimStartX, hzY, L.orientSmallSize, smallR, cols & 0xFF, isValid);
  svg += dualColorSquareSVG(dimStartX, hzY + L.orientSmallSize, L.orientSmallSize, smallR, rows & 0xFF, isValid);
  svg += dualColorSquareSVG(dimStartX + L.orientSmallSize, hzY, L.orientSmallSize, smallR, (cols >> 8) & 0xFF, isValid);
  svg += dualColorSquareSVG(dimStartX + L.orientSmallSize, hzY + L.orientSmallSize, L.orientSmallSize, smallR, (rows >> 8) & 0xFF, isValid);

  // Optional label in the orientation strip
  if (label) {
    const labelX = dimStartX + 2 * L.orientSmallSize + Math.max(4, L.orientSize * 0.15);
    const maxX = L.dataZoneX + L.cols * L.cellSize - L.cellSize;
    if (maxX > labelX + 10) {
      const fontSize = Math.max(7, L.orientSize * 0.3);
      // No measureText in SVG generation — approximate width per character
      const maxChars = Math.floor((maxX - labelX) / (fontSize * 0.62));
      const text = label.length > maxChars ? label.substring(0, Math.max(1, maxChars - 1)) + '…' : label;
      if (maxChars >= 2) {
        svg += `<text x="${labelX}" y="${hzY + L.orientHeight / 2}" text-anchor="start" dominant-baseline="central" fill="#1A1A1A" font-size="${fontSize}" font-weight="bold" font-family="sans-serif">${escapeXml(text)}</text>`;
      }
    }
  }

  // Data cells
  for (let row = 0; row < L.rows; row++) {
    for (let col = 0; col < L.cols; col++) {
      const idx = row * L.cols + col;
      const colorIdx = idx < nibbles.length ? nibbles[idx] : 14;

      const x = L.dataZoneX + col * L.cellSize;
      const y = L.dataZoneY + row * L.cellSize;
      const { gap, radius } = cellGeometry(L.cellSize);

      svg += `<rect x="${x + gap}" y="${y + gap}" width="${L.cellSize - gap * 2}" height="${L.cellSize - gap * 2}"${radius > 0 ? ` rx="${radius}"` : ''} fill="${PALETTE[colorIdx].hex}"/>`;
    }
  }

  svg += '</svg>';
  return svg;
}

function dualColorSquareSVG(
  x: number,
  y: number,
  size: number,
  radius: number,
  value: number,
  active: boolean,
): string {
  const hi = (value >> 4) & 0x0F;
  const lo = value & 0x0F;
  const halfH = (size - 2) / 2;
  const hiFill = active ? PALETTE[hi].hex : ORIENT_COLOURS.inactive;
  const loFill = active ? PALETTE[lo].hex : ORIENT_COLOURS.inactive;
  return (
    `<rect x="${x}" y="${y}" width="${size - 2}" height="${halfH}" rx="${radius}" ry="${radius}" fill="${hiFill}"/>` +
    `<rect x="${x}" y="${y + halfH}" width="${size - 2}" height="${halfH}" rx="${radius}" ry="${radius}" fill="${loFill}"/>`
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
