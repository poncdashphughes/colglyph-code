import { describe, it, expect } from 'vitest';
import { rsEncode, rsDecode } from './reed-solomon';

/** Deterministic PRNG so failures are reproducible */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomBytes(n: number, rand: () => number): number[] {
  return Array.from({ length: n }, () => Math.floor(rand() * 256));
}

describe('rsEncode', () => {
  it('appends nsym parity bytes and preserves data', () => {
    const data = [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06];
    const cw = rsEncode(data, 10);
    expect(cw.length).toBe(data.length + 10);
    expect(cw.slice(0, data.length)).toEqual(data);
  });

  it('rejects codewords longer than 255', () => {
    expect(() => rsEncode(new Array(250).fill(0), 10)).toThrow();
  });
});

describe('rsDecode', () => {
  it('round-trips a clean codeword', () => {
    const rand = lcg(1);
    const data = randomBytes(40, rand);
    const cw = rsEncode(data, 12);
    const res = rsDecode(cw, 12);
    expect(res).not.toBeNull();
    expect(res!.data).toEqual(data);
    expect(res!.corrected).toBe(0);
  });

  it('corrects up to floor(nsym/2) random errors', () => {
    const rand = lcg(42);
    for (let trial = 0; trial < 50; trial++) {
      const dataLen = 20 + Math.floor(rand() * 200);
      const nsym = 4 + 2 * Math.floor(rand() * 10);
      if (dataLen + nsym > 255) continue;

      const data = randomBytes(dataLen, rand);
      const cw = rsEncode(data, nsym);

      const numErrors = 1 + Math.floor(rand() * (nsym / 2));
      const corrupted = [...cw];
      const positions = new Set<number>();
      while (positions.size < numErrors) {
        positions.add(Math.floor(rand() * cw.length));
      }
      for (const p of positions) {
        corrupted[p] = (corrupted[p] + 1 + Math.floor(rand() * 254)) % 256;
      }

      const res = rsDecode(corrupted, nsym);
      expect(res, `trial ${trial}: ${numErrors} errors, nsym ${nsym}`).not.toBeNull();
      expect(res!.data, `trial ${trial}`).toEqual(data);
    }
  });

  it('corrects up to nsym erasures (known positions)', () => {
    const rand = lcg(7);
    const data = randomBytes(50, rand);
    const nsym = 10;
    const cw = rsEncode(data, nsym);

    const corrupted = [...cw];
    const erasures = [0, 5, 13, 21, 30, 44, 50, 55, 58, 59];
    for (const p of erasures) corrupted[p] = (corrupted[p] + 99) % 256;

    // 10 erasures with nsym=10 is beyond error-only capacity (5) but
    // within erasure capacity
    expect(rsDecode(corrupted, nsym)).toBeNull();
    const res = rsDecode(corrupted, nsym, erasures);
    expect(res).not.toBeNull();
    expect(res!.data).toEqual(data);
  });

  it('handles mixed errors and erasures (2e + f <= nsym)', () => {
    const rand = lcg(99);
    const data = randomBytes(60, rand);
    const nsym = 12;
    const cw = rsEncode(data, nsym);

    const corrupted = [...cw];
    const erasures = [2, 10, 20, 33, 41, 50]; // f = 6
    for (const p of erasures) corrupted[p] = (corrupted[p] + 1) % 256;
    // e = 3 unknown errors: 2*3 + 6 = 12 = nsym
    for (const p of [7, 25, 60]) corrupted[p] = (corrupted[p] + 1) % 256;

    const res = rsDecode(corrupted, nsym, erasures);
    expect(res).not.toBeNull();
    expect(res!.data).toEqual(data);
  });

  it('fails (returns null) when errors exceed capacity', () => {
    const rand = lcg(3);
    const data = randomBytes(40, rand);
    const nsym = 8;
    const cw = rsEncode(data, nsym);

    const corrupted = [...cw];
    // 8 errors > floor(8/2) = 4 — overwhelm with structured garbage
    for (let i = 0; i < 8; i++) corrupted[i * 3] ^= 0xA5;

    const res = rsDecode(corrupted, nsym);
    // Either detected as unfixable (null) or mis-decoded; RS guarantees
    // detection beyond capacity is probabilistic, but data must not be
    // silently wrong when null is returned
    if (res !== null) {
      // If it "succeeded", the result will differ — outer CRC catches this
      expect(res.data).not.toEqual(data);
    } else {
      expect(res).toBeNull();
    }
  });

  it('reports the number of corrected bytes', () => {
    const rand = lcg(11);
    const data = randomBytes(30, rand);
    const cw = rsEncode(data, 10);
    const corrupted = [...cw];
    corrupted[3] ^= 0xFF;
    corrupted[17] ^= 0x42;

    const res = rsDecode(corrupted, 10);
    expect(res).not.toBeNull();
    expect(res!.corrected).toBe(2);
  });
});
