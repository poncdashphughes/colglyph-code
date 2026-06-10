import type { MediaSize, GlyphLayout } from './types';

/**
 * Calculate the optimal grid layout for a given media size.
 *
 * Layout (top to bottom):
 *   1. Quiet zone
 *   2. Orientation zone — 5 coloured squares (1 large + 4 small in 2x2)
 *      showing page info, like mediglyph's human zone
 *   3. Gap (half quiet zone)
 *   4. Data grid — fills remaining space with square cells
 *   5. Quiet zone
 */
export function createLayout(media: MediaSize, cellScale = 1): GlyphLayout {
  const ppu = media.pxPerUnit;

  const canvasWidth = Math.round(media.width * ppu);
  const canvasHeight = Math.round(media.height * ppu);
  const quietZone = Math.round(media.quietZone * ppu);
  // cellScale < 1 packs denser grids (higher capacity, less print margin).
  // Floors: 0.5mm for paper (fine-printer territory), 4px for screens.
  const minCellUnits = Math.max(
    media.minCellSize * cellScale,
    media.category === 'paper' ? 0.5 : 4,
  );
  const minCell = minCellUnits * ppu;

  const usableWidth = canvasWidth - quietZone * 2;

  // Orientation zone sizing: large square = 3 cells tall, small = 1.5 cells
  // Layout: [S0 big] [3×2 info grid] [2×2 dual-colour dims] = orientSize + 5*smallSize wide
  // Minimum 30px ensures orientation squares are reliably readable for decoding
  const orientSize = Math.max(30, minCell * 3, usableWidth * 0.04);
  const orientSmallSize = orientSize / 2;
  const orientHeight = orientSize; // height of the orientation row (2 small squares tall)
  const orientGap = quietZone * 0.5;

  // Data zone starts after quiet + orient + gap
  const usableHeight = canvasHeight - quietZone * 2 - orientHeight - orientGap;

  // Determine the number of columns and rows that fit at minimum cell size
  const cols = Math.floor(usableWidth / minCell);
  const rows = Math.floor(usableHeight / minCell);

  // Use actual cell size (may be slightly larger than minimum)
  const cellSize = Math.min(usableWidth / cols, usableHeight / rows);

  // Centre the data grid horizontally
  const gridWidth = cols * cellSize;
  const gridHeight = rows * cellSize;
  const dataZoneX = quietZone + (usableWidth - gridWidth) / 2;
  const dataZoneY = quietZone + orientHeight + orientGap + (usableHeight - gridHeight) / 2;

  const capacityCells = cols * rows;
  const capacityBytes = Math.floor(capacityCells / 2);

  return {
    mediaSize: media,
    canvasWidth,
    canvasHeight,
    quietZone,
    cols,
    rows,
    cellSize,
    dataZoneX,
    dataZoneY,
    capacityBytes,
    capacityCells,
    orientSize,
    orientSmallSize,
    orientHeight,
    orientX: quietZone,
    orientY: quietZone,
  };
}
