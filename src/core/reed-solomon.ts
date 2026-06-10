/**
 * Reed–Solomon error correction over GF(2^8).
 *
 * Standard RS(n, k) with primitive polynomial 0x11D and generator α = 2
 * (the same field as QR codes). Each codeword is at most 255 bytes:
 * k data bytes followed by (n - k) parity bytes.
 *
 * Supports both unknown-position errors and known-position erasures:
 * a codeword with nsym parity bytes can correct e errors and f erasures
 * as long as 2e + f <= nsym.
 */

// ── GF(256) arithmetic ──

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function gfPow(x: number, power: number): number {
  if (x === 0) return power === 0 ? 1 : 0;
  let p = (GF_LOG[x] * power) % 255;
  if (p < 0) p += 255;
  return GF_EXP[p];
}

function gfInverse(x: number): number {
  if (x === 0) throw new Error('GF inverse of zero');
  return GF_EXP[255 - GF_LOG[x]];
}

// ── Polynomials (index 0 = highest-degree coefficient) ──

function polyScale(p: number[], x: number): number[] {
  return p.map(c => gfMul(c, x));
}

function polyAdd(p: number[], q: number[]): number[] {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) {
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

function polyEval(p: number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) {
    y = gfMul(y, x) ^ p[i];
  }
  return y;
}

/** Polynomial division; returns [quotient, remainder] */
function polyDiv(dividend: number[], divisor: number[]): [number[], number[]] {
  const out = [...dividend];
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < divisor.length; j++) {
        if (divisor[j] !== 0) out[i + j] ^= gfMul(divisor[j], coef);
      }
    }
  }
  const sep = divisor.length - 1;
  return [out.slice(0, out.length - sep), out.slice(out.length - sep)];
}

// ── Encoding ──

const genCache = new Map<number, number[]>();

function generatorPoly(nsym: number): number[] {
  const cached = genCache.get(nsym);
  if (cached) return cached;
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, [1, gfPow(2, i)]);
  }
  genCache.set(nsym, g);
  return g;
}

/** Encode a message, returning data with nsym parity bytes appended */
export function rsEncode(data: number[], nsym: number): number[] {
  if (data.length + nsym > 255) throw new Error(`RS codeword too long: ${data.length + nsym} > 255`);
  const gen = generatorPoly(nsym);
  const out = [...data, ...new Array(nsym).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        out[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  return out;
}

// ── Decoding ──

/** Syndromes with a leading 0 pad (so synd[i] corresponds to α^(i-1)) */
function calcSyndromes(msg: number[], nsym: number): number[] {
  const synd = [0];
  for (let i = 0; i < nsym; i++) synd.push(polyEval(msg, gfPow(2, i)));
  return synd;
}

/** Transform syndromes to hide known erasures from the error locator search */
function forneySyndromes(synd: number[], erasePos: number[], msgLen: number): number[] {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = gfPow(2, msgLen - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) {
      fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
    }
  }
  return fsynd;
}

/**
 * Berlekamp–Massey error locator polynomial.
 * Expects Forney syndromes when erasures are present (the erasure
 * contribution is already folded in, so indexing starts at 0 and only
 * nsym - eraseCount syndromes carry information).
 */
function findErrorLocator(synd: number[], nsym: number, eraseCount: number): number[] | null {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = Math.max(0, synd.length - nsym);
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length > 0 && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  // errs counts unknown errors only; capacity bound is 2e + f <= nsym
  if (errs * 2 + eraseCount > nsym) return null;
  return errLoc;
}

/** Chien search: find error positions from a (reversed) locator polynomial */
function findErrors(errLocRev: number[], msgLen: number): number[] | null {
  const errs = errLocRev.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < msgLen; i++) {
    if (polyEval(errLocRev, gfPow(2, i)) === 0) pos.push(msgLen - 1 - i);
  }
  if (pos.length !== errs) return null;
  return pos;
}

/** Errata locator polynomial from known coefficient positions */
function errataLocator(coefPos: number[]): number[] {
  let eLoc = [1];
  for (const i of coefPos) {
    eLoc = polyMul(eLoc, polyAdd([1], [gfPow(2, i), 0]));
  }
  return eLoc;
}

/** Error evaluator polynomial: (synd · errLoc) mod x^(n+1) */
function findErrorEvaluator(syndRev: number[], errLoc: number[], n: number): number[] {
  const divisor = [1, ...new Array(n + 1).fill(0)];
  return polyDiv(polyMul(syndRev, errLoc), divisor)[1];
}

/** Forney algorithm: compute error magnitudes and correct the message in place */
function correctErrata(msg: number[], synd: number[], errPos: number[]): number[] {
  const coefPos = errPos.map(p => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = findErrorEvaluator([...synd].reverse(), errLoc, errLoc.length - 1);

  const X = coefPos.map(cp => gfPow(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);

  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    }
    if (errLocPrime === 0) throw new Error('Could not find error magnitude');
    const y = gfMul(Xi, polyEval(errEval, XiInv));
    E[errPos[i]] = gfDiv(y, errLocPrime);
  }

  return msg.map((m, idx) => m ^ E[idx]);
}

export interface RsResult {
  /** Corrected data bytes (codeword minus parity) */
  data: number[];
  /** Number of bytes that were corrected */
  corrected: number;
}

/**
 * Decode a received codeword (data + nsym parity bytes).
 * erasePos lists known-suspect byte positions within the codeword.
 * Returns null if the errors exceed correction capacity.
 */
export function rsDecode(codeword: number[], nsym: number, erasePos: number[] = []): RsResult | null {
  if (codeword.length > 255 || nsym <= 0 || nsym >= codeword.length) return null;
  if (erasePos.length > nsym) return null;

  const msg = [...codeword];
  for (const e of erasePos) msg[e] = 0;

  const synd = calcSyndromes(msg, nsym);
  if (Math.max(...synd) === 0) {
    return { data: msg.slice(0, msg.length - nsym), corrected: countDiff(codeword, msg) };
  }

  try {
    const fsynd = forneySyndromes(synd, erasePos, msg.length);
    const errLoc = findErrorLocator(fsynd, nsym, erasePos.length);
    if (!errLoc) return null;
    const errPos = findErrors([...errLoc].reverse(), msg.length);
    if (!errPos) return null;

    const corrected = correctErrata(msg, synd, [...erasePos, ...errPos]);
    if (Math.max(...calcSyndromes(corrected, nsym)) > 0) return null;
    return { data: corrected.slice(0, corrected.length - nsym), corrected: countDiff(codeword, corrected) };
  } catch {
    return null;
  }
}

function countDiff(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) n++;
  }
  return n;
}
