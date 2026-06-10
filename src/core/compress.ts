/**
 * Transparent payload compression using the browser-native
 * CompressionStream API (deflate-raw). Files are compressed before
 * paging and decompressed after reassembly; the v1.2 header flags a
 * compressed payload so the decoder knows to inflate.
 */

export function compressionAvailable(): boolean {
  return typeof CompressionStream !== 'undefined';
}

/** Deflate; returns null when the platform lacks CompressionStream */
export async function compressBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (!compressionAvailable()) return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate a deflate-raw stream; throws on corrupt input */
export async function decompressBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
