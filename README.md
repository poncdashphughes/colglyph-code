# ColGlyphCode

Encode any file into a printable, camera-readable colour glyph — and decode it back, entirely offline.

**[Live demo](https://poncdashphughes.github.io/colglyph-code/)**

ColGlyphCode stores data as a grid of 16 colours. Each cell encodes a 4-bit nibble, and every page is protected by Reed–Solomon error correction, so a glyph survives smudges, glare, slight rotation, and colour-cast lighting. Everything runs in the browser: no server, no connectivity, no app install.

From **A4 pages** holding 10-35 KB each (depending on cell density) to **50×30mm labels** holding a few hundred bytes, the same encoding works at every size. Files larger than one page split across up to 255 self-identifying pages that can be scanned in any order.

Two capacity multipliers stack on top of the raw grid:

- **Cell density** — Standard (1.5mm cells on A4), Fine (1.0mm, ~2× capacity), Ultra (0.8mm, ~3× capacity). Denser grids need a better printer and a steadier scan; verify a test print before relying on Ultra.
- **Transparent compression** — files are deflated (browser-native `CompressionStream`) before paging whenever that shrinks them. Text, JSON, CSV and code typically gain 2-6×; already-compressed formats pass through unchanged. The decoder inflates automatically after reassembly.

## How it works

### Glyph anatomy

```
┌──────────────────────────────────────────────┐
│ ┌────┐ ┌──┬──┬──┐ ┌──┬──┐                    │
│ │ CG │ │P1│9K│C │ │lo│hi│  LABEL   ← header  │
│ │    │ ├──┼──┼──┤ ├──┼──┤            strip   │
│ └────┘ │.T│EC│R │ │lo│hi│                    │
│        └──┴──┴──┘ └──┴──┘                    │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ ████████ data grid ██████████████████████│ │
│ │ ██ 16-colour cells, 4 bits per cell █████│ │
│ │ ██ Reed–Solomon protected ███████████████│ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **Header strip** — a red identity square ("CG"), six info squares (page number, file size, grid columns/rows, extension, ECC marker), and four dual-colour squares that machine-encode the grid dimensions (16-bit columns and rows, low and high bytes). An optional human-readable label is drawn here — never over data cells.
- **Data grid** — square cells, each one of 16 palette colours encoding a nibble. The grid is sized automatically from the chosen media: cell size never drops below the minimum reliable size for that medium.

### Page format (v1.2)

Each page's cell stream is:

| Region | Size | Content |
|--------|------|---------|
| Preamble | 2 bytes | Magic `0xC6`, version `0x12` — raw, used for fast detection |
| RS-protected region | rest of grid | Interleaved Reed–Solomon codewords |

The RS block plan is derived deterministically from the byte count (~16% parity, blocks ≤ 255 bytes, QR-style interleaving), so no ECC configuration needs to be stored. Once corrected, the region contains a 26-byte header followed by the payload:

| Bytes | Field |
|-------|-------|
| 0–1 | Magic + version (protected copy) |
| 2–3 | Page number, total pages |
| 4–7 | Total stream size (u32 — compressed size when the flag is set) |
| 8–9 | Payload length this page |
| 10–11 | CRC-16 of payload |
| 12–15 | Grid columns, rows (u16 each) |
| 16–21 | Filename (extension + base, 5-bit packed) |
| 22 | Flags (bit 0: payload is deflate-raw compressed) |
| 23 | Reserved |
| 24–25 | CRC-16 of header |

Interleaving spreads physically adjacent damage (a smudge, a glare spot) across many RS blocks, so localised damage stays within each block's correction capacity. Cells the sampler reads with low confidence are passed to the decoder as **erasures**, which doubles correction power exactly where the image is worst.

Older glyphs still decode: v1.1 (24-byte header, no flags) through the same RS path, v1.0 (no ECC, 20-byte raw header) through a legacy fallback.

### Decoding pipeline

1. **Preprocess** (photos): find the glyph's white rectangle, fit its edges, perspective-warp to fronto-parallel, normalise white balance against the quiet zone.
2. **Locate zones**: find the header strip via the red identity square, then the gap that separates it from the data grid.
3. **Grid dimensions**: read from the dual-colour squares; every candidate is verified by a full RS/CRC-validated decode before being trusted, with brute-force search as fallback.
4. **Lattice refinement**: a four-corner sampling lattice is tuned by coordinate descent (offset, scale, rotation, per-corner) against palette-match quality — this absorbs the residual shear and tilt a warp always leaves.
5. **Sample and decode**: multi-point voting per cell (centre-only for small cells), then RS correction with erasure hints, header/payload CRC validation, and multi-page reassembly.

## Development

```bash
npm install
npm run dev     # dev server
npm test        # unit tests (RS codec, ECC plan, binary format)
npm run build   # type-check + production build
```

### Browser test harness

The dev build exposes a console harness that exercises the full pixel pipeline:

```js
await testAll()                        // battery across media sizes and densities
testRoundTrip('a4')                    // clean render → decode
testRoundTrip('a4', undefined, 8/15)   // same at Ultra density
testCorruption('business-card', 40)    // paint N cells wrong, verify RS recovery
testCameraCapture('a6', 5)             // simulated photo: rotation, scale, colour cast
await testCompressed('a6')             // deflate → encode → decode → inflate
testDiag('a4')                         // locate cells that sample wrong
```

## Status

Working proof of concept. Verified: clean round trips at all shipped media sizes and densities (up to 250×345 grids), recovery from dozens of corrupted cells, compressed multi-page reassembly, and simulated camera captures up to 8° rotation with strong colour cast. Real-world print-and-scan testing — especially at Fine and Ultra density — is the next step.

Possible future work:

- Data masking (QR-style XOR patterns) so sparse files don't render as mostly-black pages
- Structured-append checksum so pages from different files can't be mixed
- A timing pattern for exact cell counting on very large grids
- Selectable ECC level (lower parity for clean screen-to-screen transfers)

## Licence

Dual licence, matching the wider ColourGlyphs project family:

- **Specification** (format, palette, geometry): [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **Software** (encoder, decoder, tools): [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html)

See [LICENCE](LICENCE) for full terms.

Created by **Peter Hughes**.

- Project: [https://poncdashphughes.github.io/colglyph-code/](https://poncdashphughes.github.io/colglyph-code/)
- GitHub: [https://github.com/poncdashphughes/colglyph-code](https://github.com/poncdashphughes/colglyph-code)
- Sibling project: [MediglyphCode](https://github.com/poncdashphughes/mediglyph-code) — the same glyph family applied to emergency medical identification
