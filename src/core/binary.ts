import type { GlyphLayout } from './types';
import { computeEccPlan, eccProtect, eccRecover } from './ecc';

/**
 * Glyph binary format v1.2 — each glyph page is a self-contained cell
 * stream:
 *
 *   [preamble: 2 bytes, raw]  [RS-protected region: rest of the grid]
 *
 * Preamble (unprotected, used for fast format detection while the
 * decoder is still searching for the grid):
 *   Byte 0: Magic (0xC6)
 *   Byte 1: Version (0x12)
 *
 * The RS-protected region is `capacityBytes - 2` bytes of interleaved
 * Reed–Solomon codewords (see ecc.ts — the block plan is derived from
 * the byte count, so nothing about the ECC needs to be stored).
 * Once corrected, it contains:
 *
 * Header (26 bytes in v1.2):
 *   Byte  0:     Magic (0xC6) — protected copy
 *   Byte  1:     Version (0x12)
 *   Byte  2:     Page number (0-indexed)
 *   Byte  3:     Total pages (max 255)
 *   Bytes 4-7:   Total stream size (big-endian u32 — compressed size
 *                when the compressed flag is set)
 *   Bytes 8-9:   Payload length this page (big-endian u16)
 *   Bytes 10-11: CRC-16 of this page's payload
 *   Bytes 12-13: Grid columns (big-endian u16)
 *   Bytes 14-15: Grid rows (big-endian u16)
 *   Bytes 16-17: File extension (3 chars, 5-bit packed)
 *   Bytes 18-21: Filename base (up to 6 chars, 5-bit packed)
 *   Byte  22:    Flags (bit 0: payload is deflate-raw compressed)
 *   Byte  23:    Reserved (0)
 *   Bytes 24-25: CRC-16 of header bytes 0-23
 *
 * Payload: remaining data bytes encode the file stream (zero-padded).
 *
 * v1.1 glyphs (24-byte header, no flags) decode via the same RS path.
 * v1.0 glyphs (no error correction, 20-byte raw header, u16 file size)
 * are still decoded via the legacy path.
 */

export const MAGIC = 0xC6;
export const VERSION = 0x12;
export const VERSION_1_1 = 0x11;
export const VERSION_1_0 = 0x10;
export const MAX_PAGES = 255;

const PREAMBLE_BYTES = 2;
const HEADER_BYTES = 26;
const HEADER_BYTES_V11 = 24;
const LEGACY_HEADER_BYTES = 20;

const FLAG_COMPRESSED = 0x01;

/** CRC-16/CCITT for payload integrity */
export function crc16(data: number[]): number {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/** Pack a character into 5 bits (A-Z=1-26, 0-9=27-36, '.'=37, '-'=38, '_'=39, else=0) */
function charTo5bit(ch: string): number {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 65 && c <= 90) return c - 64;      // A-Z
  if (c >= 48 && c <= 57) return c - 48 + 27;  // 0-9
  if (ch === '.') return 37;
  if (ch === '-') return 38;
  if (ch === '_') return 39;
  return 0; // space/unknown
}

/** Unpack 5-bit value to character */
function bit5ToChar(v: number): string {
  if (v >= 1 && v <= 26) return String.fromCharCode(64 + v);
  if (v >= 27 && v <= 36) return String.fromCharCode(48 + v - 27);
  if (v === 37) return '.';
  if (v === 38) return '-';
  if (v === 39) return '_';
  return '';
}

/** Pack N chars into ceil(N*5/8) bytes using 5-bit encoding */
function pack5bit(name: string, maxChars: number): number[] {
  const padded = name.substring(0, maxChars).padEnd(maxChars, ' ');
  const vals = Array.from(padded).map(charTo5bit);
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const v of vals) {
    buf = (buf << 5) | (v & 0x1F);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xFF);
    }
  }
  if (bits > 0) {
    bytes.push((buf << (8 - bits)) & 0xFF);
  }
  return bytes;
}

/** Unpack 5-bit encoded bytes into chars */
function unpack5bit(bytes: number[], maxChars: number): string {
  let buf = 0;
  let bits = 0;
  let byteIdx = 0;
  const chars: string[] = [];
  for (let i = 0; i < maxChars; i++) {
    while (bits < 5) {
      buf = (buf << 8) | (bytes[byteIdx++] || 0);
      bits += 8;
    }
    bits -= 5;
    chars.push(bit5ToChar((buf >> bits) & 0x1F));
  }
  return chars.join('').trim();
}

/** Split filename into base and extension */
function splitFilename(name: string): { base: string; ext: string } {
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return { base: name.substring(0, 6), ext: '' };
  return {
    base: name.substring(0, dotIdx).substring(0, 6),
    ext: name.substring(dotIdx + 1).substring(0, 3),
  };
}

/** Reconstruct filename from base and extension */
function joinFilename(base: string, ext: string): string {
  if (!ext) return base;
  return `${base}.${ext}`;
}

/** Convert byte array to colour cell nibbles (4 bits each) */
export function bytesToNibbles(data: number[]): number[] {
  const cells: number[] = [];
  for (const byte of data) {
    cells.push((byte >> 4) & 0x0F);
    cells.push(byte & 0x0F);
  }
  return cells;
}

/** Convert nibbles back to bytes */
export function nibblesToBytes(nibbles: number[]): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < nibbles.length; i += 2) {
    bytes.push((nibbles[i] << 4) | (nibbles[i + 1] ?? 0));
  }
  return bytes;
}

/** Header info displayed in the orientation zone */
export interface PageMeta {
  page: number;
  totalPages: number;
  fileSize: number;
  payloadLength: number;
  cols: number;
  rows: number;
  extension: string;
  filename: string;
  compressed: boolean;
}

export interface EncodedPage {
  /** Final cell-stream bytes (preamble + interleaved RS codewords); length = layout.capacityBytes */
  bytes: number[];
  meta: PageMeta;
}

/** Usable payload bytes per page after preamble, header, and RS parity */
export function pagePayloadCapacity(layout: GlyphLayout): number {
  const rsRegion = layout.capacityBytes - PREAMBLE_BYTES;
  if (rsRegion < HEADER_BYTES + 2) return 0;
  const plan = computeEccPlan(rsRegion);
  // Header bytes 8-9 carry payload length as u16 — a grid can hold more
  // than 65,535 payload bytes (e.g. large screens at Ultra density), but
  // a page must never claim to.
  return Math.min(Math.max(0, plan.dataBytes - HEADER_BYTES), 0xFFFF);
}

/**
 * Encode a file into one or more glyph pages.
 * Pass compressed: true when fileBytes is a deflate-raw stream — the
 * flag travels in the header so the decoder knows to inflate after
 * reassembly.
 */
export function encodeFile(
  fileBytes: Uint8Array,
  filename: string,
  layout: GlyphLayout,
  opts: { compressed?: boolean } = {},
): EncodedPage[] {
  const payloadCapacity = pagePayloadCapacity(layout);
  if (payloadCapacity < 1) {
    throw new Error(`${layout.mediaSize.name} is too small to hold a glyph — choose a larger size`);
  }

  const totalSize = fileBytes.length;
  if (totalSize > 0xFFFFFFFF) {
    throw new Error('File too large (maximum 4 GB)');
  }
  const totalPages = Math.max(1, Math.ceil(totalSize / payloadCapacity));
  if (totalPages > MAX_PAGES) {
    throw new Error(
      `File needs ${totalPages} pages at ${layout.mediaSize.name} (maximum ${MAX_PAGES}) — choose a larger size`,
    );
  }

  // Extract filename base (strip path, keep extension)
  const baseName = filename.split('/').pop()?.split('\\').pop() || 'file';
  const { base, ext } = splitFilename(baseName);
  const extBytes = pack5bit(ext, 3);   // 3 chars → 2 bytes
  const baseBytes = pack5bit(base, 6); // 6 chars → 4 bytes

  const plan = computeEccPlan(layout.capacityBytes - PREAMBLE_BYTES);
  const pages: EncodedPage[] = [];

  for (let page = 0; page < totalPages; page++) {
    const start = page * payloadCapacity;
    const end = Math.min(start + payloadCapacity, totalSize);
    const payload = Array.from(fileBytes.slice(start, end));
    const payloadLen = payload.length;

    // Pad payload to fill the ECC plan's data region — this can exceed
    // payloadCapacity when the u16 header field caps the usable payload
    // below what the grid physically holds (the surplus is padding).
    // Padding is pseudo-random rather than zero: decoders ignore it (the
    // header's payload length bounds what is kept), and a run of zeros
    // renders as a field of black cells that camera lattice refinement
    // has nothing to lock onto — a file's short final page was
    // measurably harder to decode live than its full pages.
    let pad = (0x9E3779B1 ^ Math.imul(page + 1, 0x85EBCA6B)) >>> 0;
    while (payload.length < plan.dataBytes - HEADER_BYTES) {
      pad = (Math.imul(pad, 1664525) + 1013904223) >>> 0;
      payload.push(pad >>> 24);
    }

    const checksum = crc16(payload.slice(0, payloadLen));

    const header: number[] = [
      MAGIC,                              // 0: magic (protected copy)
      VERSION,                            // 1: version
      page,                               // 2: page number
      totalPages,                         // 3: total pages
      (totalSize >>> 24) & 0xFF,          // 4-7: stream size (u32)
      (totalSize >>> 16) & 0xFF,
      (totalSize >>> 8) & 0xFF,
      totalSize & 0xFF,
      (payloadLen >> 8) & 0xFF,           // 8-9: payload length
      payloadLen & 0xFF,
      (checksum >> 8) & 0xFF,             // 10-11: payload CRC
      checksum & 0xFF,
      (layout.cols >> 8) & 0xFF,          // 12-13: grid columns
      layout.cols & 0xFF,
      (layout.rows >> 8) & 0xFF,          // 14-15: grid rows
      layout.rows & 0xFF,
      ...extBytes,                        // 16-17: extension
      ...baseBytes,                       // 18-21: filename base
      opts.compressed ? FLAG_COMPRESSED : 0, // 22: flags
      0,                                  // 23: reserved
    ];
    const headerCrc = crc16(header);
    header.push((headerCrc >> 8) & 0xFF, headerCrc & 0xFF); // 24-25

    const protectedBytes = eccProtect([...header, ...payload], plan);

    pages.push({
      bytes: [MAGIC, VERSION, ...protectedBytes],
      meta: {
        page,
        totalPages,
        fileSize: totalSize,
        payloadLength: payloadLen,
        cols: layout.cols,
        rows: layout.rows,
        extension: ext.toUpperCase(),
        filename: baseName,
        compressed: !!opts.compressed,
      },
    });
  }

  return pages;
}

export interface DecodedPageInfo {
  valid: boolean;
  version: number;
  page: number;
  totalPages: number;
  fileSize: number;
  payloadLength: number;
  checksum: number;
  checksumValid: boolean;
  cols: number;
  rows: number;
  extension: string;
  filename: string;
  payload: number[];
  /** Payload is a deflate-raw stream — inflate after reassembly */
  compressed: boolean;
  /** Bytes repaired by Reed–Solomon (0 for clean reads and v1.0 glyphs) */
  correctedBytes: number;
  /** RS blocks that could not be repaired (payload likely damaged) */
  failedBlocks: number;
}

/**
 * Decode a page from its sampled cell-stream bytes.
 * Tries the RS-protected formats (v1.1/v1.2) first, then falls back to
 * legacy v1.0.
 */
export function decodeTransmit(bytes: number[], suspectPos?: Set<number>): DecodedPageInfo {
  const protectedInfo = decodeProtected(bytes, suspectPos);
  if (protectedInfo && protectedInfo.valid) return protectedInfo;

  const legacy = decodeLegacy(bytes);
  if (legacy.valid) return legacy;

  return protectedInfo ?? legacy;
}

function decodeProtected(bytes: number[], suspectPos?: Set<number>): DecodedPageInfo | null {
  if (bytes.length < PREAMBLE_BYTES + HEADER_BYTES + 2) return null;

  const plan = computeEccPlan(bytes.length - PREAMBLE_BYTES);
  // Shift suspect positions into the RS region's frame of reference
  let rsSuspects: Set<number> | undefined;
  if (suspectPos && suspectPos.size > 0) {
    rsSuspects = new Set<number>();
    for (const p of suspectPos) {
      if (p >= PREAMBLE_BYTES) rsSuspects.add(p - PREAMBLE_BYTES);
    }
  }

  const rec = eccRecover(bytes.slice(PREAMBLE_BYTES), plan, rsSuspects);
  const d = rec.data;

  // Header length and CRC position depend on the version byte (which is
  // itself RS-protected, then confirmed by the header CRC)
  const version = d[1];
  const isV12 = version === VERSION;
  const headerLen = isV12 ? HEADER_BYTES : HEADER_BYTES_V11;
  const crcOff = headerLen - 2;
  const headerCrc = (d[crcOff] << 8) | d[crcOff + 1];
  const headerValid =
    d[0] === MAGIC &&
    (version === VERSION || version === VERSION_1_1) &&
    crc16(d.slice(0, crcOff)) === headerCrc;

  const fileSize = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
  const payloadLength = (d[8] << 8) | d[9];
  const checksum = (d[10] << 8) | d[11];
  const ext = unpack5bit(d.slice(16, 18), 3);
  const base = unpack5bit(d.slice(18, 22), 6);
  const flags = isV12 ? d[22] : 0;

  const payload = d.slice(headerLen, headerLen + payloadLength);
  const checksumValid = headerValid && payload.length === payloadLength && crc16(payload) === checksum;

  return {
    valid: headerValid,
    version,
    page: d[2],
    totalPages: d[3],
    fileSize,
    payloadLength,
    checksum,
    checksumValid,
    cols: (d[12] << 8) | d[13],
    rows: (d[14] << 8) | d[15],
    extension: ext,
    filename: joinFilename(base, ext),
    payload,
    compressed: (flags & FLAG_COMPRESSED) !== 0,
    correctedBytes: rec.correctedBytes,
    failedBlocks: rec.failedBlocks,
  };
}

/** Legacy v1.0 page decode (raw 20-byte header, u16 file size, no ECC) */
function decodeLegacy(bytes: number[]): DecodedPageInfo {
  const magic = bytes[0] ?? 0;
  const version = bytes[1] ?? 0;
  const fileSize = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
  const payloadLength = ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0);
  const checksum = ((bytes[8] ?? 0) << 8) | (bytes[9] ?? 0);
  const ext = unpack5bit(bytes.slice(14, 16), 3);
  const base = unpack5bit(bytes.slice(16, 20), 6);

  const payload = bytes.slice(LEGACY_HEADER_BYTES, LEGACY_HEADER_BYTES + payloadLength);
  const checksumValid = crc16(payload) === checksum;

  return {
    valid: magic === MAGIC && version === VERSION_1_0,
    version,
    page: bytes[2] ?? 0,
    totalPages: bytes[3] ?? 0,
    fileSize,
    payloadLength,
    checksum,
    checksumValid,
    cols: ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0),
    rows: ((bytes[12] ?? 0) << 8) | (bytes[13] ?? 0),
    extension: ext,
    filename: joinFilename(base, ext),
    payload,
    compressed: false,
    correctedBytes: 0,
    failedBlocks: 0,
  };
}

/**
 * Reassemble file bytes from multiple decoded pages.
 * Pages can be in any order — they self-identify by page number.
 */
export function reassembleFile(pages: DecodedPageInfo[]): {
  bytes: Uint8Array;
  filename: string;
  complete: boolean;
  compressed: boolean;
  pagesReceived: number;
  totalPages: number;
} {
  if (pages.length === 0) {
    return { bytes: new Uint8Array(0), filename: '', complete: false, compressed: false, pagesReceived: 0, totalPages: 0 };
  }

  const totalPages = pages[0].totalPages;
  const fileSize = pages[0].fileSize;
  const filename = pages[0].filename;
  const compressed = pages[0].compressed;

  // Sort by page number
  const sorted = [...pages].sort((a, b) => a.page - b.page);

  // Concatenate payloads
  const allBytes: number[] = [];
  for (const p of sorted) {
    allBytes.push(...p.payload);
  }

  return {
    bytes: new Uint8Array(allBytes.slice(0, fileSize)),
    filename,
    complete: pages.length >= totalPages,
    compressed,
    pagesReceived: pages.length,
    totalPages,
  };
}
