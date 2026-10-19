import { describe, it, expect } from 'vitest';
import {
  encodeFile,
  decodeTransmit,
  reassembleFile,
  pagePayloadCapacity,
  bytesToNibbles,
  nibblesToBytes,
  crc16,
  MAGIC,
  VERSION_1_1,
  VERSION_1_0,
} from './binary';
import { computeEccPlan, eccProtect } from './ecc';
import { createLayout } from './glyph-layout';
import { ALL_MEDIA_SIZES, getMediaSize } from './media-sizes';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function layoutFor(id: string) {
  const media = getMediaSize(id);
  if (!media) throw new Error(`unknown media ${id}`);
  return createLayout(media);
}

describe('nibble packing', () => {
  it('round-trips bytes through nibbles', () => {
    const bytes = [0x00, 0xFF, 0xC6, 0x11, 0x5A];
    expect(nibblesToBytes(bytesToNibbles(bytes))).toEqual(bytes);
  });
});

describe('crc16', () => {
  it('matches the CCITT-FALSE check value', () => {
    // "123456789" → 0x29B1 for CRC-16/CCITT-FALSE
    const data = Array.from('123456789').map(c => c.charCodeAt(0));
    expect(crc16(data)).toBe(0x29B1);
  });
});

describe('pagePayloadCapacity', () => {
  it('is positive for every shipped media size', () => {
    for (const media of ALL_MEDIA_SIZES) {
      const layout = createLayout(media);
      expect(pagePayloadCapacity(layout), media.id).toBeGreaterThan(0);
    }
  });

  it('denser cell scales increase capacity substantially', () => {
    const a4 = getMediaSize('a4')!;
    const standard = pagePayloadCapacity(createLayout(a4));
    const fine = pagePayloadCapacity(createLayout(a4, 2 / 3));
    const ultra = pagePayloadCapacity(createLayout(a4, 8 / 15));
    expect(fine).toBeGreaterThan(standard * 1.8);
    expect(ultra).toBeGreaterThan(standard * 2.8);
  });

  it('never exceeds the u16 payload-length header field', () => {
    for (const media of ALL_MEDIA_SIZES) {
      for (const scale of [1, 2 / 3, 8 / 15]) {
        const layout = createLayout(media, scale);
        expect(pagePayloadCapacity(layout), `${media.id} @ ${scale}`).toBeLessThanOrEqual(0xffff);
      }
    }
  });

  it('clamps density to safe floors', () => {
    const a4 = getMediaSize('a4')!;
    const absurd = createLayout(a4, 0.01); // would be 0.015mm cells
    // Clamped to 0.5mm: 200mm usable / 0.5mm = 400 cols
    expect(absurd.cols).toBeLessThanOrEqual(400);
  });
});

describe('encodeFile / decodeTransmit', () => {
  it('round-trips a small text file on a single page', () => {
    const layout = layoutFor('business-card');
    const text = 'Offline readable coloured glyphs.';
    const data = new TextEncoder().encode(text);

    const pages = encodeFile(data, 'notes.txt', layout);
    expect(pages).toHaveLength(1);
    expect(pages[0].bytes.length).toBe(layout.capacityBytes);
    expect(pages[0].meta.filename).toBe('notes.txt');

    const info = decodeTransmit(pages[0].bytes);
    expect(info.valid).toBe(true);
    expect(info.checksumValid).toBe(true);
    expect(info.correctedBytes).toBe(0);
    expect(info.fileSize).toBe(data.length);
    expect(info.cols).toBe(layout.cols);
    expect(info.rows).toBe(layout.rows);
    expect(info.filename).toBe('NOTES.TXT');
    expect(new TextDecoder().decode(new Uint8Array(info.payload))).toBe(text);
  });

  it('round-trips binary data including zero and 0xFF runs', () => {
    const layout = layoutFor('label-large');
    const cap = pagePayloadCapacity(layout);
    const data = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) data[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 0xFF : i & 0xFF;

    const pages = encodeFile(data, 'blob.bin', layout);
    expect(pages).toHaveLength(1);
    const info = decodeTransmit(pages[0].bytes);
    expect(info.valid).toBe(true);
    expect(info.checksumValid).toBe(true);
    expect(new Uint8Array(info.payload)).toEqual(data);
  });

  it('splits large files across pages and reassembles them', () => {
    const layout = layoutFor('a6');
    const cap = pagePayloadCapacity(layout);
    const rand = lcg(8);
    const data = new Uint8Array(Math.floor(cap * 2.5));
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);

    const pages = encodeFile(data, 'big.bin', layout);
    expect(pages).toHaveLength(3);

    const decoded = pages.map(p => decodeTransmit(p.bytes));
    for (const d of decoded) {
      expect(d.valid).toBe(true);
      expect(d.checksumValid).toBe(true);
      expect(d.fileSize).toBe(data.length);
      expect(d.totalPages).toBe(3);
    }

    // Shuffle page order — reassembly sorts by page number
    const assembled = reassembleFile([decoded[2], decoded[0], decoded[1]]);
    expect(assembled.complete).toBe(true);
    expect(assembled.bytes).toEqual(data);
  });

  it('supports files beyond the old 64KB limit (u32 size field)', () => {
    const layout = layoutFor('a4');
    const cap = pagePayloadCapacity(layout);
    const size = 100_000; // > 0xFFFF
    expect(cap * 255).toBeGreaterThan(size);

    const rand = lcg(15);
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = Math.floor(rand() * 256);

    const pages = encodeFile(data, 'archive.zip', layout);
    const decoded = pages.map(p => decodeTransmit(p.bytes));
    expect(decoded[0].fileSize).toBe(size);
    const assembled = reassembleFile(decoded);
    expect(assembled.complete).toBe(true);
    expect(assembled.bytes).toEqual(data);
  });

  it('round-trips on a grid whose physical capacity exceeds the u16 payload cap', () => {
    const media = getMediaSize('desktop-4k')!;
    const layout = createLayout(media, 8 / 15); // Ultra — grid holds >64KB
    const cap = pagePayloadCapacity(layout);
    expect(cap).toBe(0xffff);

    const rand = lcg(23);
    const data = new Uint8Array(150_000); // forces 3 clamped pages
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);

    const pages = encodeFile(data, 'probe.bin', layout);
    expect(pages).toHaveLength(3);

    const decoded = pages.map(p => decodeTransmit(p.bytes));
    for (const d of decoded) {
      expect(d.valid).toBe(true);
      expect(d.checksumValid).toBe(true);
    }
    const assembled = reassembleFile(decoded);
    expect(assembled.complete).toBe(true);
    expect(assembled.bytes).toEqual(data);
  });

  it('pads short pages with a non-zero pattern so they do not render as black fields', () => {
    const layout = createLayout(getMediaSize('a4')!);
    const pages = encodeFile(new Uint8Array([1, 2, 3]), 'tiny.bin', layout);
    expect(pages).toHaveLength(1);
    const zeros = pages[0].bytes.filter(b => b === 0).length;
    expect(zeros).toBeLessThan(pages[0].bytes.length * 0.2);

    const decoded = decodeTransmit(pages[0].bytes);
    expect(decoded.valid).toBe(true);
    expect(decoded.checksumValid).toBe(true);
    expect(decoded.payload).toEqual([1, 2, 3]);
  });

  it('throws a descriptive error when a file needs more than 255 pages', () => {
    const layout = layoutFor('label-medium');
    const data = new Uint8Array(10_000_000);
    expect(() => encodeFile(data, 'huge.iso', layout)).toThrow(/pages/);
  });

  it('recovers from corrupted stream bytes via Reed–Solomon', () => {
    const layout = layoutFor('business-card');
    const text = 'Error correction makes print-and-scan viable.';
    const data = new TextEncoder().encode(text);
    const pages = encodeFile(data, 'ecc.txt', layout);

    const rand = lcg(33);
    const corrupted = [...pages[0].bytes];
    // Corrupt 4% of bytes after the preamble
    const n = Math.floor(corrupted.length * 0.04);
    const positions = new Set<number>();
    while (positions.size < n) {
      positions.add(2 + Math.floor(rand() * (corrupted.length - 2)));
    }
    for (const p of positions) corrupted[p] ^= 0x6B;

    const info = decodeTransmit(corrupted);
    expect(info.valid).toBe(true);
    expect(info.checksumValid).toBe(true);
    expect(info.correctedBytes).toBe(n);
    expect(new TextDecoder().decode(new Uint8Array(info.payload))).toBe(text);
  });

  it('reports failure honestly when damage exceeds ECC capacity', () => {
    const layout = layoutFor('label-large');
    const data = new TextEncoder().encode('short');
    const pages = encodeFile(data, 'x.txt', layout);

    const corrupted = pages[0].bytes.map((b, i) => (i > 1 && i % 2 === 0 ? b ^ 0x99 : b));
    const info = decodeTransmit(corrupted);
    // Must not silently return wrong data as valid
    expect(info.valid && info.checksumValid).toBe(false);
  });
});

describe('v1.2 compression flag', () => {
  it('round-trips the compressed flag through encode and decode', () => {
    const layout = layoutFor('business-card');
    const data = new TextEncoder().encode('pretend-deflate-stream');
    const pages = encodeFile(data, 'doc.txt', layout, { compressed: true });
    expect(pages[0].meta.compressed).toBe(true);

    const info = decodeTransmit(pages[0].bytes);
    expect(info.valid).toBe(true);
    expect(info.checksumValid).toBe(true);
    expect(info.compressed).toBe(true);

    const assembled = reassembleFile([info]);
    expect(assembled.compressed).toBe(true);
    expect(new Uint8Array(assembled.bytes)).toEqual(data);
  });

  it('defaults to uncompressed', () => {
    const layout = layoutFor('business-card');
    const pages = encodeFile(new TextEncoder().encode('plain'), 'p.txt', layout);
    const info = decodeTransmit(pages[0].bytes);
    expect(info.valid).toBe(true);
    expect(info.compressed).toBe(false);
  });

  it('survives corruption with the flag intact', () => {
    const layout = layoutFor('a6');
    const data = new TextEncoder().encode('compressed payload with errors');
    const pages = encodeFile(data, 'z.bin', layout, { compressed: true });
    const corrupted = pages[0].bytes.map((b, i) => (i > 1 && i % 31 === 0 ? b ^ 0x44 : b));
    const info = decodeTransmit(corrupted);
    expect(info.valid).toBe(true);
    expect(info.checksumValid).toBe(true);
    expect(info.compressed).toBe(true);
    expect(info.correctedBytes).toBeGreaterThan(0);
  });
});

describe('v1.1 compatibility', () => {
  it('decodes a hand-built v1.1 page (24-byte header, no flags)', () => {
    const layout = layoutFor('label-large');
    const plan = computeEccPlan(layout.capacityBytes - 2);
    const payload = Array.from(new TextEncoder().encode('V11PAGE'));
    const checksum = crc16(payload);

    const header = [
      MAGIC, VERSION_1_1,
      0, 1,
      0, 0, 0, payload.length,               // u32 size
      0, payload.length,                     // payload length
      (checksum >> 8) & 0xFF, checksum & 0xFF,
      (layout.cols >> 8) & 0xFF, layout.cols & 0xFF,
      (layout.rows >> 8) & 0xFF, layout.rows & 0xFF,
      0, 0,                                  // ext (blank)
      0, 0, 0, 0,                            // base (blank)
    ];
    const headerCrc = crc16(header);
    header.push((headerCrc >> 8) & 0xFF, headerCrc & 0xFF); // 24-byte header

    const data = [...header, ...payload];
    while (data.length < plan.dataBytes) data.push(0);
    const bytes = [MAGIC, VERSION_1_1, ...eccProtect(data, plan)];

    const info = decodeTransmit(bytes);
    expect(info.valid).toBe(true);
    expect(info.version).toBe(VERSION_1_1);
    expect(info.checksumValid).toBe(true);
    expect(info.compressed).toBe(false);
    expect(new TextDecoder().decode(new Uint8Array(info.payload))).toBe('V11PAGE');
  });
});

describe('legacy v1.0 fallback', () => {
  it('decodes a v1.0 page (raw 20-byte header, no ECC)', () => {
    const payload = Array.from(new TextEncoder().encode('LEGACY'));
    const checksum = crc16(payload);
    const header = [
      MAGIC, VERSION_1_0,
      0, 1,                                  // page 0 of 1
      0, payload.length,                     // u16 file size
      0, payload.length,                     // payload length
      (checksum >> 8) & 0xFF, checksum & 0xFF,
      0, 40, 0, 20,                          // cols 40, rows 20
      0, 0,                                  // ext (blank)
      0, 0, 0, 0,                            // base (blank)
    ];
    const bytes = [...header, ...payload, ...new Array(300).fill(0)];

    const info = decodeTransmit(bytes);
    expect(info.valid).toBe(true);
    expect(info.version).toBe(VERSION_1_0);
    expect(info.checksumValid).toBe(true);
    expect(info.cols).toBe(40);
    expect(info.rows).toBe(20);
    expect(new TextDecoder().decode(new Uint8Array(info.payload))).toBe('LEGACY');
  });
});
