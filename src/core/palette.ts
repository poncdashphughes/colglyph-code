import type { PaletteEntry } from './types';

/** 16-colour palette — each colour encodes a 4-bit nibble (0-15) */
export const PALETTE: PaletteEntry[] = [
  { name: 'Black',   hex: '#000000', rgb: [0, 0, 0] },
  { name: 'White',   hex: '#FFFFFF', rgb: [255, 255, 255] },
  { name: 'Red',     hex: '#D92626', rgb: [217, 38, 38] },
  { name: 'Orange',  hex: '#E87D1A', rgb: [232, 125, 26] },
  { name: 'Yellow',  hex: '#E8D31A', rgb: [232, 211, 26] },
  { name: 'Lime',    hex: '#5CB531', rgb: [92, 181, 49] },
  { name: 'Green',   hex: '#1A8C5A', rgb: [26, 140, 90] },
  { name: 'Teal',    hex: '#1ABCBC', rgb: [26, 188, 188] },
  { name: 'Blue',    hex: '#2E6FBF', rgb: [46, 111, 191] },
  { name: 'Navy',    hex: '#1A2E5C', rgb: [26, 46, 92] },
  { name: 'Purple',  hex: '#7D3DAD', rgb: [125, 61, 173] },
  { name: 'Magenta', hex: '#CC2D7F', rgb: [204, 45, 127] },
  { name: 'Brown',   hex: '#8C5C26', rgb: [140, 92, 38] },
  { name: 'Grey',    hex: '#5C5C5C', rgb: [92, 92, 92] },
  { name: 'Silver',  hex: '#ADADAD', rgb: [173, 173, 173] },
  { name: 'Pink',    hex: '#F2A0B8', rgb: [242, 160, 184] },
];

/** Euclidean distance in RGB space */
export function colorDistance(a: number[] | [number, number, number], b: number[] | [number, number, number]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

/** Luminance for choosing text colour (black/white) over a background */
export function getLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(v => v / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
