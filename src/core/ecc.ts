/**
 * Page-level error correction: splits a page's byte budget into
 * Reed–Solomon blocks (each ≤ 255 bytes) and interleaves them so a
 * localised smudge or glare spot spreads across blocks instead of
 * overwhelming one.
 *
 * The plan is a pure function of the page's total byte count, so the
 * decoder can reconstruct it from the grid dimensions alone — no ECC
 * configuration needs to be stored in the glyph.
 */
import { rsEncode, rsDecode } from './reed-solomon';

export interface EccBlock {
  dataLen: number;
  parityLen: number;
}

export interface EccPlan {
  /** Total bytes in the protected region (data + parity) */
  totalBytes: number;
  /** Usable data bytes */
  dataBytes: number;
  /** Parity bytes */
  parityBytes: number;
  blocks: EccBlock[];
}

/** Fraction of the page spent on parity (~8% of bytes correctable per block) */
const PARITY_RATIO = 0.16;
const MIN_PARITY = 8;

export function computeEccPlan(totalBytes: number): EccPlan {
  let parityBytes = Math.max(MIN_PARITY, Math.round(totalBytes * PARITY_RATIO));
  parityBytes = Math.min(parityBytes, Math.floor(totalBytes / 2));
  const dataBytes = totalBytes - parityBytes;

  const numBlocks = Math.max(1, Math.ceil(totalBytes / 255));
  const blocks: EccBlock[] = [];
  for (let i = 0; i < numBlocks; i++) {
    const size = Math.floor(totalBytes / numBlocks) + (i < totalBytes % numBlocks ? 1 : 0);
    const parity = Math.floor(parityBytes / numBlocks) + (i < parityBytes % numBlocks ? 1 : 0);
    blocks.push({ dataLen: size - parity, parityLen: parity });
  }

  return { totalBytes, dataBytes, parityBytes, blocks };
}

/** Interleave parts column-wise: part0[0], part1[0], ..., part0[1], part1[1], ... */
function interleave(parts: number[][]): number[] {
  const out: number[] = [];
  const maxLen = Math.max(...parts.map(p => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of parts) {
      if (i < p.length) out.push(p[i]);
    }
  }
  return out;
}

/** Reverse of interleave(); returns parts with the given lengths */
function deinterleave(stream: number[], lengths: number[]): number[][] {
  const parts: number[][] = lengths.map(() => []);
  const maxLen = Math.max(...lengths);
  let idx = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let p = 0; p < parts.length; p++) {
      if (i < lengths[p]) parts[p].push(stream[idx++] ?? 0);
    }
  }
  return parts;
}

/** Like deinterleave, but returns the stream index each byte came from */
function deinterleaveOrigins(streamOffset: number, lengths: number[]): number[][] {
  const parts: number[][] = lengths.map(() => []);
  const maxLen = Math.max(...lengths);
  let idx = streamOffset;
  for (let i = 0; i < maxLen; i++) {
    for (let p = 0; p < parts.length; p++) {
      if (i < lengths[p]) parts[p].push(idx++);
    }
  }
  return parts;
}

/**
 * Protect a page: RS-encode `data` (length must equal plan.dataBytes)
 * and return the interleaved codeword stream (length = plan.totalBytes).
 */
export function eccProtect(data: number[], plan: EccPlan): number[] {
  if (data.length !== plan.dataBytes) {
    throw new Error(`ECC data length mismatch: got ${data.length}, expected ${plan.dataBytes}`);
  }
  const dataParts: number[][] = [];
  const parityParts: number[][] = [];
  let off = 0;
  for (const b of plan.blocks) {
    const d = data.slice(off, off + b.dataLen);
    off += b.dataLen;
    const cw = rsEncode(d, b.parityLen);
    dataParts.push(d);
    parityParts.push(cw.slice(b.dataLen));
  }
  return interleave(dataParts).concat(interleave(parityParts));
}

export interface EccRecovery {
  /** Best-effort recovered data (length = plan.dataBytes) */
  data: number[];
  /** Total bytes corrected across all blocks */
  correctedBytes: number;
  /** Blocks whose errors exceeded correction capacity */
  failedBlocks: number;
}

/**
 * Recover a page from a received stream.
 * suspectPos optionally lists stream byte indices the sampler had low
 * confidence in — these are treated as RS erasures, doubling the
 * correction power at those positions.
 */
export function eccRecover(received: number[], plan: EccPlan, suspectPos?: Set<number>): EccRecovery {
  const dataLens = plan.blocks.map(b => b.dataLen);
  const parityLens = plan.blocks.map(b => b.parityLen);

  const dataParts = deinterleave(received.slice(0, plan.dataBytes), dataLens);
  const parityParts = deinterleave(received.slice(plan.dataBytes, plan.totalBytes), parityLens);
  const dataOrigins = deinterleaveOrigins(0, dataLens);
  const parityOrigins = deinterleaveOrigins(plan.dataBytes, parityLens);

  const out: number[] = [];
  let correctedBytes = 0;
  let failedBlocks = 0;

  for (let i = 0; i < plan.blocks.length; i++) {
    const block = plan.blocks[i];
    const cw = dataParts[i].concat(parityParts[i]);

    let erasures: number[] = [];
    if (suspectPos && suspectPos.size > 0) {
      const origins = dataOrigins[i].concat(parityOrigins[i]);
      erasures = origins
        .map((origin, pos) => (suspectPos.has(origin) ? pos : -1))
        .filter(p => p >= 0);
      // Too many erasures would leave no margin for unknown errors — drop them
      if (erasures.length > block.parityLen - 2) erasures = [];
    }

    let res = rsDecode(cw, block.parityLen, erasures);
    if (!res && erasures.length > 0) {
      // Erasure hints may themselves be wrong — retry errors-only
      res = rsDecode(cw, block.parityLen);
    }

    if (res) {
      out.push(...res.data);
      correctedBytes += res.corrected;
    } else {
      failedBlocks++;
      out.push(...dataParts[i]);
    }
  }

  return { data: out, correctedBytes, failedBlocks };
}
