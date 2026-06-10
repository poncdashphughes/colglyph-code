/** A media target — either a physical paper size or a screen size */
export interface MediaSize {
  id: string;
  name: string;
  category: 'paper' | 'screen';
  /** Width in mm (paper) or px (screen) */
  width: number;
  /** Height in mm (paper) or px (screen) */
  height: number;
  /** Minimum cell size in mm (paper) or px (screen) for reliable scanning */
  minCellSize: number;
  /** Quiet zone border in mm (paper) or px (screen) */
  quietZone: number;
  /** Pixels per mm for rendering (paper only — screen uses 1:1) */
  pxPerUnit: number;
}

/** Computed layout for a glyph at a given media size */
export interface GlyphLayout {
  mediaSize: MediaSize;
  /** Canvas width in pixels */
  canvasWidth: number;
  /** Canvas height in pixels */
  canvasHeight: number;
  /** Quiet zone in pixels */
  quietZone: number;
  /** Number of columns in the data grid */
  cols: number;
  /** Number of rows in the data grid */
  rows: number;
  /** Cell size in pixels */
  cellSize: number;
  /** Data zone X offset in pixels */
  dataZoneX: number;
  /** Data zone Y offset in pixels */
  dataZoneY: number;
  /** Total data capacity in bytes */
  capacityBytes: number;
  /** Total data capacity in nibbles (colour cells) */
  capacityCells: number;
  /** Orientation zone: large square size in pixels */
  orientSize: number;
  /** Orientation zone: small square size in pixels */
  orientSmallSize: number;
  /** Orientation zone: total height in pixels */
  orientHeight: number;
  /** Orientation zone: X offset in pixels */
  orientX: number;
  /** Orientation zone: Y offset in pixels */
  orientY: number;
}

/** Raw data payload for encoding */
export interface GlyphData {
  /** Raw bytes to encode */
  bytes: number[];
  /** Optional label to overlay on first row */
  label?: string;
}

/** Result of decoding a glyph image */
export interface DecodedResult {
  /** Raw decoded bytes */
  bytes: number[];
  /** Hex string representation */
  hex: string;
  /** Decoded as UTF-8 text (best effort) */
  text: string;
  /** Average decode confidence 0-1 */
  confidence: number;
  /** Grid dimensions detected */
  cols: number;
  rows: number;
  /** Full decoded page (header fields + payload), when a grid was sampled */
  pageInfo?: import('./binary').DecodedPageInfo;
  /** Debug info */
  debug?: Record<string, unknown>;
  error?: string;
}

export interface PaletteEntry {
  name: string;
  hex: string;
  rgb: [number, number, number];
}

export interface ColourMatch {
  index: number;
  distance: number;
  confidence: number;
  color: string;
}
