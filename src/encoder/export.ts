import type { GlyphLayout } from '../core/types';
import type { PageMeta } from '../core/binary';
import { renderGlyphSVG } from './glyph-renderer';

/** Download canvas as PNG */
export function downloadPNG(canvas: HTMLCanvasElement, filename: string = 'colglyph.png') {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

/** Download SVG file */
export function downloadSVG(
  pageBytes: number[],
  meta: PageMeta | null,
  layout: GlyphLayout,
  label: string | undefined,
  filename: string = 'colglyph.svg',
) {
  const svg = renderGlyphSVG(pageBytes, meta, layout, label);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const link = document.createElement('a');
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Copy encoded hex data to clipboard */
export async function copyHexData(encodedData: number[]): Promise<void> {
  const hex = encodedData.map(b => b.toString(16).padStart(2, '0')).join(' ');
  await navigator.clipboard.writeText(hex);
}

/** Download raw bytes as a file */
export function downloadFile(bytes: Uint8Array, filename: string, mimeType: string = 'application/octet-stream') {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const link = document.createElement('a');
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}
