import type { MediaSize } from './types';

/**
 * Paper sizes — dimensions in mm.
 * minCellSize is the minimum mm per cell for camera-readable scanning.
 * pxPerUnit converts mm → render pixels.
 */
export const PAPER_SIZES: MediaSize[] = [
  // ISO A-series
  { id: 'a4',             name: 'A4',              category: 'paper', width: 210,  height: 297,  minCellSize: 1.5,  quietZone: 5,    pxPerUnit: 10 },
  { id: 'a5',             name: 'A5',              category: 'paper', width: 148,  height: 210,  minCellSize: 1.5,  quietZone: 4,    pxPerUnit: 10 },
  { id: 'a6',             name: 'A6',              category: 'paper', width: 105,  height: 148,  minCellSize: 1.5,  quietZone: 3,    pxPerUnit: 10 },
  { id: 'a7',             name: 'A7',              category: 'paper', width: 74,   height: 105,  minCellSize: 1.5,  quietZone: 2.5,  pxPerUnit: 10 },
  { id: 'a8',             name: 'A8',              category: 'paper', width: 52,   height: 74,   minCellSize: 1.0,  quietZone: 2,    pxPerUnit: 15 },
  // US sizes
  { id: 'letter',         name: 'US Letter',       category: 'paper', width: 216,  height: 279,  minCellSize: 1.5,  quietZone: 5,    pxPerUnit: 10 },
  { id: 'half-letter',    name: 'US Half Letter',  category: 'paper', width: 140,  height: 216,  minCellSize: 1.5,  quietZone: 4,    pxPerUnit: 10 },
  // Cards & labels
  { id: 'business-card',  name: 'Business Card',   category: 'paper', width: 85,   height: 55,   minCellSize: 1.0,  quietZone: 2,    pxPerUnit: 15 },
  { id: 'credit-card',    name: 'Credit Card',     category: 'paper', width: 85.6, height: 53.98,minCellSize: 1.0,  quietZone: 2,    pxPerUnit: 15 },
  { id: 'label-large',    name: 'Label (50×30mm)',  category: 'paper', width: 50,   height: 30,   minCellSize: 1.0,  quietZone: 1.5,  pxPerUnit: 15 },
  { id: 'label-medium',   name: 'Label (30×20mm)',  category: 'paper', width: 30,   height: 20,   minCellSize: 0.8,  quietZone: 1,    pxPerUnit: 20 },
  { id: 'label-mediglyph',name: 'Mediglyph (18×10mm)', category: 'paper', width: 18, height: 10, minCellSize: 0.8,  quietZone: 0.75, pxPerUnit: 20 },
  // Stickers & badges
  { id: 'badge',          name: 'Badge (86×54mm)',  category: 'paper', width: 86,   height: 54,   minCellSize: 1.0,  quietZone: 2,    pxPerUnit: 15 },
  { id: 'sticker-round',  name: 'Sticker (40×40mm)',category: 'paper', width: 40,   height: 40,   minCellSize: 1.0,  quietZone: 1.5,  pxPerUnit: 15 },
  { id: 'postcard',       name: 'Postcard',        category: 'paper', width: 148,  height: 105,  minCellSize: 1.5,  quietZone: 3,    pxPerUnit: 10 },
];

/**
 * Screen sizes — dimensions in pixels.
 * minCellSize is the minimum px per cell for camera/screenshot readability.
 * pxPerUnit is 1 (pixels are already the native unit).
 */
export const SCREEN_SIZES: MediaSize[] = [
  { id: 'mobile-sm',     name: 'Mobile Small (320×568)',   category: 'screen', width: 320,  height: 568,  minCellSize: 4,  quietZone: 8,   pxPerUnit: 1 },
  { id: 'mobile',        name: 'Mobile (375×667)',         category: 'screen', width: 375,  height: 667,  minCellSize: 4,  quietZone: 10,  pxPerUnit: 1 },
  { id: 'mobile-lg',     name: 'Mobile Large (428×926)',   category: 'screen', width: 428,  height: 926,  minCellSize: 4,  quietZone: 10,  pxPerUnit: 1 },
  { id: 'tablet',        name: 'Tablet (768×1024)',        category: 'screen', width: 768,  height: 1024, minCellSize: 5,  quietZone: 16,  pxPerUnit: 1 },
  { id: 'tablet-lg',     name: 'Tablet Large (1024×1366)', category: 'screen', width: 1024, height: 1366, minCellSize: 5,  quietZone: 20,  pxPerUnit: 1 },
  { id: 'laptop',        name: 'Laptop (1440×900)',        category: 'screen', width: 1440, height: 900,  minCellSize: 5,  quietZone: 20,  pxPerUnit: 1 },
  { id: 'desktop',       name: 'Desktop (1920×1080)',      category: 'screen', width: 1920, height: 1080, minCellSize: 6,  quietZone: 24,  pxPerUnit: 1 },
  // Custom aspect ratios
  { id: 'square-sm',     name: 'Square 256px',             category: 'screen', width: 256,  height: 256,  minCellSize: 4,  quietZone: 6,   pxPerUnit: 1 },
  { id: 'square-md',     name: 'Square 512px',             category: 'screen', width: 512,  height: 512,  minCellSize: 5,  quietZone: 10,  pxPerUnit: 1 },
  { id: 'square-lg',     name: 'Square 1024px',            category: 'screen', width: 1024, height: 1024, minCellSize: 6,  quietZone: 16,  pxPerUnit: 1 },
];

export const ALL_MEDIA_SIZES: MediaSize[] = [...PAPER_SIZES, ...SCREEN_SIZES];

export function getMediaSize(id: string): MediaSize | undefined {
  return ALL_MEDIA_SIZES.find(s => s.id === id);
}
