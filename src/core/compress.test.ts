import { describe, it, expect } from 'vitest';
import { compressBytes, decompressBytes, compressionAvailable } from './compress';

describe('compress', () => {
  it('is available in this runtime', () => {
    expect(compressionAvailable()).toBe(true);
  });

  it('round-trips bytes through deflate-raw', async () => {
    const text = 'ColGlyph compression test. '.repeat(100);
    const raw = new TextEncoder().encode(text);
    const deflated = await compressBytes(raw);
    expect(deflated).not.toBeNull();
    const inflated = await decompressBytes(deflated!);
    expect(new TextDecoder().decode(inflated)).toBe(text);
  });

  it('shrinks repetitive content substantially', async () => {
    const raw = new TextEncoder().encode('abcdefgh'.repeat(500));
    const deflated = await compressBytes(raw);
    expect(deflated!.length).toBeLessThan(raw.length / 5);
  });

  it('round-trips binary data', async () => {
    const raw = new Uint8Array(2048);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + (i >> 3)) & 0xFF;
    const deflated = await compressBytes(raw);
    const inflated = await decompressBytes(deflated!);
    expect(inflated).toEqual(raw);
  });

  it('throws on corrupt compressed input', async () => {
    const garbage = new Uint8Array([1, 2, 3, 251, 250, 249]);
    await expect(decompressBytes(garbage)).rejects.toThrow();
  });
});
