import type { DecodedResult } from '../core/types';
import { decodeTransmit, nibblesToBytes, MAGIC, VERSION, VERSION_1_1, VERSION_1_0 } from '../core/binary';
import { sampleCellFromBuffer, matchToPalette } from './classify-color';
import { colorDistance } from '../core/palette';

interface ContentBounds {
  found: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Pre-read image buffer for fast pixel access */
interface ImageBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const ORIENT_RED: [number, number, number] = [217, 38, 38];

/** Cells sampled below this confidence are passed to RS as erasures */
const SUSPECT_CONFIDENCE = 0.5;

export function decodeFromImage(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  expectedCols?: number,
  expectedRows?: number,
): DecodedResult {
  const width = canvas.width;
  const height = canvas.height;

  // Read entire image into buffer once
  const imageData = ctx.getImageData(0, 0, width, height);
  const buf: ImageBuffer = { data: imageData.data, width, height };

  // Step 1: Find full content bounds
  const fullBounds = findContentBounds(buf);
  if (!fullBounds.found) {
    return { bytes: [], hex: '', text: '', confidence: 0, cols: 0, rows: 0, error: 'Could not find glyph content' };
  }

  // Step 2: Detect orientation zone → find data grid bounds
  const orientInfo = findOrientationZone(buf, fullBounds);
  const dataBounds = orientInfo.dataBounds;

  // Content bounds are inclusive pixel coords, so add 1 for actual dimensions
  const contentWidth = dataBounds.maxX - dataBounds.minX + 1;
  const contentHeight = dataBounds.maxY - dataBounds.minY + 1;

  if (contentWidth < 10 || contentHeight < 10) {
    return { bytes: [], hex: '', text: '', confidence: 0, cols: 0, rows: 0, error: 'Data area too small' };
  }

  // Step 3+4: Determine grid dimensions and decode.
  // Candidate dimensions are only trusted after a full sample + decode
  // passes RS/CRC validation — a partial magic check is too weak to
  // distinguish correct dims from near-misses.
  let attempt: GridAttempt | null = null;

  if (expectedCols && expectedRows) {
    // Explicit hints from the user — trust them
    attempt = sampleGridAndDecode(buf, dataBounds, contentWidth, contentHeight, expectedCols, expectedRows, 0);
  } else {
    if (orientInfo.cols > 0 && orientInfo.rows > 0) {
      attempt = sampleGridAndDecode(buf, dataBounds, contentWidth, contentHeight, orientInfo.cols, orientInfo.rows, 0);
    }
    if (!attempt || !(attempt.pageInfo.valid && attempt.pageInfo.checksumValid)) {
      // Orientation dims missing or unverified — brute-force search
      const detected = detectGridSize(buf, dataBounds, contentWidth, contentHeight);
      const bruteAttempt = sampleGridAndDecode(buf, dataBounds, contentWidth, contentHeight, detected.cols, detected.rows, detected.offsetX);
      attempt = chooseBetterAttempt(attempt, bruteAttempt);
    }
  }

  const { nibbles: _nibbles, cols, rows, cellSize, confidence, suspects, pageInfo } = attempt;

  const hex = pageInfo.payload.map(b => b.toString(16).padStart(2, '0')).join(' ');
  const text = tryDecodeText(pageInfo.payload);

  return {
    bytes: pageInfo.payload,
    hex,
    text,
    confidence,
    cols,
    rows,
    pageInfo,
    debug: {
      fullBounds,
      dataBounds,
      cellWidth: cellSize,
      cellHeight: cellSize,
      suspectBytes: suspects,
    },
  };
}

interface GridAttempt {
  nibbles: number[];
  cols: number;
  rows: number;
  cellSize: number;
  confidence: number;
  suspects: number;
  pageInfo: ReturnType<typeof decodeTransmit>;
}

/** Sample a full grid at the given dimensions and run a real decode */
function sampleGridAndDecode(
  buf: ImageBuffer,
  dataBounds: ContentBounds,
  contentWidth: number,
  contentHeight: number,
  cols: number,
  rows: number,
  offsetX: number,
): GridAttempt {
  // Cells are square — use the same sizing as createLayout
  const cellSize = Math.min(contentWidth / cols, contentHeight / rows);
  // The grid is centered within the data bounds, with optional X offset correction
  const gridWidth = cols * cellSize;
  const gridHeight = rows * cellSize;
  const gridStartX = dataBounds.minX + offsetX + (contentWidth - gridWidth) / 2;
  const gridStartY = dataBounds.minY + (contentHeight - gridHeight) / 2;

  // Content bounds from photos are inflated by antialiased smear and the
  // perspective warp leaves residual shear, so a uniform grid estimate
  // accumulates whole-cell drift at the far edges. Refine a 4-corner
  // sampling lattice against the image before committing to a full sample.
  const map0: GridMap = {
    tl: { x: gridStartX, y: gridStartY },
    tr: { x: gridStartX + gridWidth, y: gridStartY },
    bl: { x: gridStartX, y: gridStartY + gridHeight },
    br: { x: gridStartX + gridWidth, y: gridStartY + gridHeight },
  };
  const map = refineGridMap(buf, map0, cols, rows, cellSize, cellSize);

  const { nibbles, confidence, cellConfidences } = sampleDataZone(
    buf, map, cellSize, cellSize, cols, rows,
  );

  // Flag low-confidence bytes as RS erasures
  const expectedBytes = Math.floor((cols * rows) / 2);
  const bytes = nibblesToBytes(nibbles).slice(0, expectedBytes);
  const suspects = new Set<number>();
  for (let i = 0; i < expectedBytes; i++) {
    const c0 = cellConfidences[i * 2] ?? 0;
    const c1 = cellConfidences[i * 2 + 1] ?? 0;
    if (Math.min(c0, c1) < SUSPECT_CONFIDENCE) suspects.add(i);
  }

  const pageInfo = decodeTransmit(bytes, suspects);
  const cellW = (map.tr.x - map.tl.x) / cols;
  return { nibbles, cols, rows, cellSize: cellW, confidence, suspects: suspects.size, pageInfo };
}

interface Pt { x: number; y: number }

/** Four-corner sampling lattice — cell centres are bilinearly interpolated */
interface GridMap { tl: Pt; tr: Pt; bl: Pt; br: Pt }

function cellCenter(map: GridMap, cols: number, rows: number, c: number, r: number): Pt {
  const u = (c + 0.5) / cols;
  const v = (r + 0.5) / rows;
  const topX = map.tl.x + u * (map.tr.x - map.tl.x);
  const topY = map.tl.y + u * (map.tr.y - map.tl.y);
  const botX = map.bl.x + u * (map.br.x - map.bl.x);
  const botY = map.bl.y + u * (map.br.y - map.bl.y);
  return { x: topX + v * (botX - topX), y: topY + v * (botY - topY) };
}

/**
 * Fine-tune the sampling lattice by coordinate descent, scoring each
 * configuration by how closely a sparse lattice of probe cells matches
 * the palette. Searches global offset first, then symmetric scale, then
 * each corner independently — the last stage absorbs shear and residual
 * perspective that a uniform grid cannot express.
 */
function refineGridMap(
  buf: ImageBuffer,
  map0: GridMap,
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
): GridMap {
  const probeCols: number[] = [];
  const cStep = Math.max(1, Math.floor(cols / 16));
  for (let c = 0; c < cols; c += cStep) probeCols.push(c);
  if (probeCols[probeCols.length - 1] !== cols - 1) probeCols.push(cols - 1);
  const probeRows: number[] = [];
  const rStep = Math.max(1, Math.floor(rows / 8));
  for (let r = 0; r < rows; r += rStep) probeRows.push(r);
  if (probeRows[probeRows.length - 1] !== rows - 1) probeRows.push(rows - 1);

  const radius = Math.min(cellW, cellH) < 6 ? 0 : 1;
  const score = (m: GridMap): number => {
    let total = 0;
    for (const r of probeRows) {
      for (const c of probeCols) {
        const p = cellCenter(m, cols, rows, c, r);
        const s = sampleCellFromBuffer(buf.data, buf.width, buf.height, p.x, p.y, radius);
        total += matchToPalette(s).distance;
      }
    }
    return total;
  };

  const move = (m: GridMap, corners: (keyof GridMap)[], dx: number, dy: number): GridMap => {
    const out: GridMap = { tl: { ...m.tl }, tr: { ...m.tr }, bl: { ...m.bl }, br: { ...m.br } };
    for (const k of corners) {
      out[k] = { x: out[k].x + dx, y: out[k].y + dy };
    }
    return out;
  };

  let best = map0;
  let bestScore = score(map0);
  const trial = (m: GridMap) => {
    const s = score(m);
    if (s < bestScore) { bestScore = s; best = m; }
  };

  const rotate = (m: GridMap, deg: number): GridMap => {
    const cx = (m.tl.x + m.tr.x + m.bl.x + m.br.x) / 4;
    const cy = (m.tl.y + m.tr.y + m.bl.y + m.br.y) / 4;
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const rot = (p: Pt): Pt => ({
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
      y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
    });
    return { tl: rot(m.tl), tr: rot(m.tr), bl: rot(m.bl), br: rot(m.br) };
  };

  const steps = [-2, -1, -0.5, 0.5, 1, 2];
  const rotSteps = [-1, -0.5, -0.25, 0.25, 0.5, 1];
  const all: (keyof GridMap)[] = ['tl', 'tr', 'bl', 'br'];

  for (let pass = 0; pass < 3; pass++) {
    // Global offset
    for (const d of steps) trial(move(best, all, d, 0));
    for (const d of steps) trial(move(best, all, 0, d));
    // Residual rotation left by the perspective warp
    for (const deg of rotSteps) trial(rotate(best, deg));
    // Symmetric scale (left/right pairs, then top/bottom pairs)
    for (const d of steps) trial(move(move(best, ['tl', 'bl'], -d, 0), ['tr', 'br'], d, 0));
    for (const d of steps) trial(move(move(best, ['tl', 'tr'], 0, -d), ['bl', 'br'], 0, d));
    // Individual corners — absorbs shear and residual perspective
    for (const corner of all) {
      for (const d of steps) trial(move(best, [corner], d, 0));
      for (const d of steps) trial(move(best, [corner], 0, d));
    }
  }

  return best;
}

function chooseBetterAttempt(a: GridAttempt | null, b: GridAttempt): GridAttempt {
  if (!a) return b;
  const score = (x: GridAttempt) =>
    (x.pageInfo.valid && x.pageInfo.checksumValid ? 4 : 0) +
    (x.pageInfo.valid ? 2 : 0) +
    x.confidence;
  return score(b) >= score(a) ? b : a;
}

function findContentBounds(buf: ImageBuffer): ContentBounds {
  let minX = buf.width, minY = buf.height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const idx = (y * buf.width + x) * 4;
      const r = buf.data[idx], g = buf.data[idx + 1], b = buf.data[idx + 2];
      if (r < 245 || g < 245 || b < 245) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return { found, minX, minY, maxX, maxY };
}

interface OrientInfo {
  dataBounds: ContentBounds;
  cols: number;
  rows: number;
}

function findOrientationZone(buf: ImageBuffer, fullBounds: ContentBounds): OrientInfo {
  const { minX, minY, maxX, maxY } = fullBounds;

  const noOrient: OrientInfo = { dataBounds: fullBounds, cols: 0, rows: 0 };

  // Check if top-left area has the red orientation square.
  // Use percentage-based offsets to handle varying quiet zone widths (camera captures).
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  let foundRed = false;
  let redFoundX = 0;
  const pctOffsets = [3, 5, 7, 2]; // fixed pixel offsets
  // Also try percentage-based offsets (2-5% of content size) for camera-preprocessed images
  const pctOff = Math.max(8, Math.round(Math.min(contentW, contentH) * 0.03));
  const offsets = [...pctOffsets, pctOff, Math.round(pctOff * 0.7), Math.round(pctOff * 1.3)];
  for (const off of offsets) {
    const sx = minX + off;
    const s = sampleCellFromBuffer(
      buf.data, buf.width, buf.height,
      sx, minY + off, 1
    );
    if (colorDistance(s, ORIENT_RED) < 80) {
      foundRed = true;
      redFoundX = sx;
      break;
    }
  }

  if (!foundRed) return noOrient;

  // Find the bottom of the red square by scanning down inside its interior.
  // Stay near the left edge — the white 'CG' text is centered, so a scan
  // line through the middle would be interrupted by it.
  const estOrientSize = Math.max(30, (maxX - minX) * 0.04);
  const scanX = redFoundX + Math.max(2, Math.round(estOrientSize * 0.05));
  // Tolerate interruptions up to ~30% of the square height (antialiased
  // text edges, specks) before deciding the red zone has ended
  const redGapTolerance = Math.max(3, Math.round(estOrientSize * 0.3));
  let orientBottomY = minY;
  let lastRedY = -1;
  let foundAnyRed = false;
  for (let y = minY + 2; y < minY + (maxY - minY) * 0.3; y++) {
    const s = sampleCellFromBuffer(buf.data, buf.width, buf.height, scanX, y, 1);
    const dist = colorDistance(s, ORIENT_RED);
    if (dist < 80) {
      lastRedY = y;
      foundAnyRed = true;
    } else if (foundAnyRed && y > lastRedY + redGapTolerance) {
      orientBottomY = lastRedY + 1;
      break;
    }
  }

  // Scan downward from the bottom of the orient zone to find the gap.
  // A real gap is several rows tall — require 3 consecutive sparse rows so
  // the 1-2px seams between orientation squares don't register as the gap.
  const scanEndY = Math.min(maxY, minY + (maxY - minY) * 0.3);
  const GAP_RUN = 3;

  let gapY = -1;
  let runStart = -1;
  let runLen = 0;
  for (let y = orientBottomY; y < scanEndY; y++) {
    let nonWhite = 0;
    for (let x = minX; x < maxX; x += 2) {
      const idx = (y * buf.width + x) * 4;
      const r = buf.data[idx], g = buf.data[idx + 1], b = buf.data[idx + 2];
      if (r < 245 || g < 245 || b < 245) nonWhite++;
    }
    if (nonWhite / ((maxX - minX) / 2) < 0.05) {
      if (runStart < 0) runStart = y;
      runLen++;
      if (runLen >= GAP_RUN) {
        gapY = runStart;
        break;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  if (gapY < 0) return noOrient;

  // Find where data grid starts (next non-white row)
  let dataStartY = gapY;
  for (let y = gapY; y < maxY; y++) {
    let nonWhite = 0;
    for (let x = minX; x < maxX; x += 2) {
      const idx = (y * buf.width + x) * 4;
      const r = buf.data[idx], g = buf.data[idx + 1], b = buf.data[idx + 2];
      if (r < 245 || g < 245 || b < 245) nonWhite++;
    }
    if (nonWhite / ((maxX - minX) / 2) > 0.1) {
      dataStartY = y;
      break;
    }
  }

  const dataBounds: ContentBounds = { found: true, minX, minY: dataStartY, maxX, maxY };

  // Read grid dimensions from the dual-colour squares.
  // Layout: [S0 big][S1][S2][S3][ColsLo][ColsHi]
  //                 [S4][S5][S6][RowsLo][RowsHi]
  // We need to find the correct orientSize to locate the dual-colour squares.
  // Try multiple candidates and pick the one that yields a plausible grid size.
  const usableWidth = maxX - minX;
  const scanBigSize = orientBottomY - minY;
  // Candidates: scan-based estimate (with small padding), formula-based, and a few common minCell*3 values
  const candidates = new Set<number>();
  candidates.add(scanBigSize);
  candidates.add(scanBigSize + 1);
  candidates.add(scanBigSize + 2);
  candidates.add(usableWidth * 0.04);
  // Common orientSize values: minimum 30px, paper minCell*ppu*3 = 45, screen minCell*3 = 12/15
  for (const v of [12, 15, 30, 45]) {
    if (v > usableWidth * 0.01 && v < usableWidth * 0.15) candidates.add(v);
  }

  let bestResult = { cols: 0, rows: 0 };
  let bestScore = -1;

  for (const bigSize of candidates) {
    const smallSize = bigSize / 2;
    const dimX = minX + bigSize + 3 * smallSize;
    const quarterH = Math.max(1, smallSize / 4);
    const sampleR = Math.min(2, quarterH);

    // Ensure we're sampling within image bounds (two dual-colour columns)
    if (dimX + 2 * smallSize > buf.width) continue;

    // Each dual-colour square holds one byte: top half = high nibble, bottom = low
    const readDual = (x: number, yTop: number): { value: number; dist: number } => {
      const cx = x + smallSize / 2;
      const hi = matchToPalette(sampleCellFromBuffer(buf.data, buf.width, buf.height, cx, yTop + quarterH, sampleR));
      const lo = matchToPalette(sampleCellFromBuffer(buf.data, buf.width, buf.height, cx, yTop + smallSize - quarterH, sampleR));
      return { value: (hi.index << 4) | lo.index, dist: hi.distance + lo.distance };
    };

    const colsLo = readDual(dimX, minY);
    const rowsLo = readDual(dimX, minY + smallSize);
    const colsHi = readDual(dimX + smallSize, minY);
    const rowsHi = readDual(dimX + smallSize, minY + smallSize);

    // High-byte squares only exist on v1.1 glyphs; on v1.0 they sample the
    // white quiet zone. Score both interpretations and let the plausibility
    // checks below discard the wrong one.
    const dimCandidates = [
      { cols: (colsHi.value << 8) | colsLo.value, rows: (rowsHi.value << 8) | rowsLo.value, dist: colsLo.dist + rowsLo.dist + colsHi.dist + rowsHi.dist },
      { cols: colsLo.value, rows: rowsLo.value, dist: colsLo.dist + rowsLo.dist },
    ];

    for (const dc of dimCandidates) {
      const { cols, rows } = dc;
      // Validate: cols and rows should produce a grid that fills the data area reasonably
      if (cols < 4 || rows < 2 || cols > 1000 || rows > 1000) continue;

      const contentHeight = dataBounds.maxY - dataBounds.minY;
      const contentDataWidth = dataBounds.maxX - dataBounds.minX;
      const cellW = contentDataWidth / cols;
      const cellH = contentHeight / rows;
      // Cells should be roughly square (within 30%)
      const ratio = Math.max(cellW, cellH) / Math.min(cellW, cellH);
      if (ratio > 1.3) continue;

      // Score: lower total colour distance = better
      const score = 1000 - dc.dist;
      if (score > bestScore) {
        bestScore = score;
        bestResult = { cols, rows };
      }
    }
  }

  return { dataBounds, cols: bestResult.cols, rows: bestResult.rows };
}

function detectGridSize(
  buf: ImageBuffer,
  bounds: ContentBounds,
  contentWidth: number,
  contentHeight: number,
): { cols: number; rows: number; offsetX: number } {
  const minCellPx = 4;
  const maxCellPx = Math.min(contentWidth, contentHeight) / 2;

  const minCols = Math.max(4, Math.floor(contentWidth / maxCellPx));
  const maxCols = Math.min(500, Math.floor(contentWidth / minCellPx));

  // Collect all candidates that pass the magic+version check.
  // Try multiple X offsets to handle anti-aliased content bounds (camera captures).
  const candidates: { cols: number; rows: number; offsetX: number }[] = [];
  const xOffsets = [0, 2, 4, 6, 8, -2];

  for (let c = minCols; c <= maxCols; c++) {
    const cellW = contentWidth / c;
    const candidateRows = Math.round(contentHeight / cellW);
    if (candidateRows < 2) continue;

    const r = Math.max(1, Math.min(cellW * 0.1, 2));

    for (const dx of xOffsets) {
      const startX = bounds.minX + dx;
      // Also try Y offsets for camera captures where gap detection may be slightly off
      const yOffsets = [0, 2, -2];
      let foundForThisCol = false;
      for (const dy of yOffsets) {
        const cy = bounds.minY + dy + cellW * 0.5;

        // Sample first 4 nibbles (magic + version)
        const s0 = sampleCellFromBuffer(buf.data, buf.width, buf.height, startX + cellW * 0.5, cy, r);
        const s1 = sampleCellFromBuffer(buf.data, buf.width, buf.height, startX + cellW * 1.5, cy, r);
        const m0 = matchToPalette(s0);
        const m1 = matchToPalette(s1);
        const byte0 = (m0.index << 4) | m1.index;
        if (byte0 !== MAGIC) continue;

        const s2 = sampleCellFromBuffer(buf.data, buf.width, buf.height, startX + cellW * 2.5, cy, r);
        const s3 = sampleCellFromBuffer(buf.data, buf.width, buf.height, startX + cellW * 3.5, cy, r);
        const m2 = matchToPalette(s2);
        const m3 = matchToPalette(s3);
        const byte1 = (m2.index << 4) | m3.index;

        if (byte1 !== VERSION && byte1 !== VERSION_1_1 && byte1 !== VERSION_1_0) continue;

        candidates.push({ cols: c, rows: candidateRows, offsetX: dx });
        foundForThisCol = true;
        break; // Found a valid offset for this column count
      }
      if (foundForThisCol) break;
    }
  }

  if (candidates.length === 0) {
    // Fallback: guess from default cell size
    return {
      cols: Math.round(contentWidth / 16),
      rows: Math.round(contentHeight / 16),
      offsetX: 0,
    };
  }

  // Verify each candidate by sampling its full grid and attempting a real
  // decode (RS-corrected for v1.1, raw CRC for v1.0)
  for (const cand of candidates) {
    // Match the main decode's cell sizing: cells are square, use min of width/height
    const cellSize = Math.min(contentWidth / cand.cols, contentHeight / cand.rows);
    const gridW = cand.cols * cellSize;
    const gridH = cand.rows * cellSize;
    const startX = bounds.minX + cand.offsetX + (contentWidth - gridW) / 2;
    const startY = bounds.minY + (contentHeight - gridH) / 2;

    const candMap: GridMap = {
      tl: { x: startX, y: startY },
      tr: { x: startX + gridW, y: startY },
      bl: { x: startX, y: startY + gridH },
      br: { x: startX + gridW, y: startY + gridH },
    };
    const { nibbles } = sampleDataZone(buf, candMap, cellSize, cellSize, cand.cols, cand.rows);
    const expectedBytes = Math.floor((cand.cols * cand.rows) / 2);
    const bytes = nibblesToBytes(nibbles).slice(0, expectedBytes);

    const pageInfo = decodeTransmit(bytes);
    if (pageInfo.valid && pageInfo.checksumValid) {
      return cand;
    }
  }

  // No verified match — pick candidate closest to square cells
  // (cells are rendered as squares, so cellW should equal cellH)
  let bestCand = candidates[0];
  let bestDiff = Infinity;
  for (const cand of candidates) {
    const cellW = contentWidth / cand.cols;
    const cellH = contentHeight / cand.rows;
    const diff = Math.abs(cellW - cellH);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCand = cand;
    }
  }

  return bestCand;
}

function sampleDataZone(
  buf: ImageBuffer,
  map: GridMap,
  cellWidth: number,
  cellHeight: number,
  cols: number,
  rows: number,
): { nibbles: number[]; confidence: number; cellConfidences: number[] } {
  const nibbles: number[] = [];
  const confidences: number[] = [];

  const minDim = Math.min(cellWidth, cellHeight);

  // For small cells (<10px), use center-only sampling to avoid bleeding into adjacent cells.
  // For larger cells, use multi-point voting for robustness (camera noise, etc.)
  if (minDim < 10) {
    const r = minDim < 6 ? 0 : Math.max(1, minDim * 0.15);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const p = cellCenter(map, cols, rows, col, row);
        const sample = sampleCellFromBuffer(buf.data, buf.width, buf.height, p.x, p.y, r);
        const match = matchToPalette(sample);
        nibbles.push(match.index);
        confidences.push(match.confidence);
      }
    }
  } else {
    // Offsets are relative to the cell centre, in cell units
    const sampleOffsets: [number, number][] = [
      [-0.2, -0.2], [0.2, -0.2],
      [-0.2, 0.2], [0.2, 0.2],
      [0, 0],
    ];
    const sampleRadius = Math.max(1.5, minDim * 0.08);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const p = cellCenter(map, cols, rows, col, row);

        const votes: Map<number, { count: number; totalDist: number; confidence: number }> = new Map();

        for (const [ox, oy] of sampleOffsets) {
          const sample = sampleCellFromBuffer(
            buf.data, buf.width, buf.height,
            p.x + cellWidth * ox, p.y + cellHeight * oy, sampleRadius
          );
          const match = matchToPalette(sample);
          const existing = votes.get(match.index);
          if (existing) {
            existing.count++;
            existing.totalDist += match.distance;
            existing.confidence = Math.max(existing.confidence, match.confidence);
          } else {
            votes.set(match.index, { count: 1, totalDist: match.distance, confidence: match.confidence });
          }
        }

        let bestIndex = 0;
        let bestCount = 0;
        let bestAvgDist = Infinity;
        let bestConfidence = 0;
        for (const [index, v] of votes) {
          const avgDist = v.totalDist / v.count;
          if (v.count > bestCount || (v.count === bestCount && avgDist < bestAvgDist)) {
            bestIndex = index;
            bestCount = v.count;
            bestAvgDist = avgDist;
            bestConfidence = v.confidence;
          }
        }

        nibbles.push(bestIndex);
        confidences.push(bestConfidence);
      }
    }
  }

  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  return { nibbles, confidence: avgConfidence, cellConfidences: confidences };
}

function tryDecodeText(bytes: number[]): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return '';
  }
}
