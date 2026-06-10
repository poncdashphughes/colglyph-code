import { describe, it, expect } from 'vitest';
import { computeEccPlan, eccProtect, eccRecover } from './ecc';

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

describe('computeEccPlan', () => {
  it('produces consistent block sums for a range of sizes', () => {
    for (const total of [40, 78, 255, 256, 992, 4096, 12435, 30000]) {
      const plan = computeEccPlan(total);
      const sumData = plan.blocks.reduce((a, b) => a + b.dataLen, 0);
      const sumParity = plan.blocks.reduce((a, b) => a + b.parityLen, 0);
      expect(sumData).toBe(plan.dataBytes);
      expect(sumParity).toBe(plan.parityBytes);
      expect(plan.dataBytes + plan.parityBytes).toBe(total);
      for (const b of plan.blocks) {
        expect(b.dataLen + b.parityLen).toBeLessThanOrEqual(255);
        expect(b.parityLen).toBeGreaterThanOrEqual(2);
        expect(b.dataLen).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('is deterministic — same input, same plan', () => {
    expect(computeEccPlan(1234)).toEqual(computeEccPlan(1234));
  });
});

describe('eccProtect / eccRecover', () => {
  it('round-trips cleanly across block-count boundaries', () => {
    const rand = lcg(5);
    for (const total of [60, 255, 256, 600, 2000]) {
      const plan = computeEccPlan(total);
      const data = randomBytes(plan.dataBytes, rand);
      const stream = eccProtect(data, plan);
      expect(stream.length).toBe(total);

      const rec = eccRecover(stream, plan);
      expect(rec.data).toEqual(data);
      expect(rec.correctedBytes).toBe(0);
      expect(rec.failedBlocks).toBe(0);
    }
  });

  it('recovers from scattered random byte errors', () => {
    const rand = lcg(21);
    const plan = computeEccPlan(992); // ~business card page
    const data = randomBytes(plan.dataBytes, rand);
    const stream = eccProtect(data, plan);

    // Corrupt ~5% of the stream at random positions
    const corrupted = [...stream];
    const n = Math.floor(stream.length * 0.05);
    const positions = new Set<number>();
    while (positions.size < n) positions.add(Math.floor(rand() * stream.length));
    for (const p of positions) corrupted[p] ^= 0x5A;

    const rec = eccRecover(corrupted, plan);
    expect(rec.failedBlocks).toBe(0);
    expect(rec.data).toEqual(data);
    expect(rec.correctedBytes).toBe(n);
  });

  it('recovers from a contiguous burst thanks to interleaving', () => {
    const rand = lcg(31);
    const plan = computeEccPlan(2000);
    const data = randomBytes(plan.dataBytes, rand);
    const stream = eccProtect(data, plan);

    // A burst of consecutive corrupted bytes (e.g. a smudge across a row).
    // Interleaving spreads these across all blocks.
    const corrupted = [...stream];
    const burstLen = Math.floor(plan.parityBytes / 2) - plan.blocks.length;
    for (let i = 200; i < 200 + burstLen; i++) corrupted[i] ^= 0xFF;

    const rec = eccRecover(corrupted, plan);
    expect(rec.failedBlocks).toBe(0);
    expect(rec.data).toEqual(data);
  });

  it('uses suspect positions as erasures to stretch correction power', () => {
    const rand = lcg(77);
    const plan = computeEccPlan(300);
    const data = randomBytes(plan.dataBytes, rand);
    const stream = eccProtect(data, plan);

    // Corrupt more bytes than error-only capacity, but flag them all
    const perBlockErrors = Math.floor(plan.blocks[0].parityLen / 2);
    const nCorrupt = Math.min(perBlockErrors * plan.blocks.length + 4, plan.blocks[0].parityLen - 3);
    const corrupted = [...stream];
    const suspects = new Set<number>();
    for (let i = 0; i < nCorrupt; i++) {
      const p = i * 7;
      corrupted[p] ^= 0x3C;
      suspects.add(p);
    }

    const rec = eccRecover(corrupted, plan, suspects);
    expect(rec.failedBlocks).toBe(0);
    expect(rec.data).toEqual(data);
  });

  it('flags failed blocks instead of throwing when damage is catastrophic', () => {
    const rand = lcg(13);
    const plan = computeEccPlan(400);
    const data = randomBytes(plan.dataBytes, rand);
    const stream = eccProtect(data, plan);

    // Destroy half the stream
    const corrupted = stream.map((b, i) => (i % 2 === 0 ? b ^ 0xA7 : b));
    const rec = eccRecover(corrupted, plan);
    expect(rec.failedBlocks).toBeGreaterThan(0);
    expect(rec.data.length).toBe(plan.dataBytes);
  });

  it('rejects data of the wrong length', () => {
    const plan = computeEccPlan(100);
    expect(() => eccProtect(new Array(plan.dataBytes + 1).fill(0), plan)).toThrow();
  });
});
