# ColGlyphCode

Encode any file into a printable, camera-readable colour glyph — and decode it back, entirely offline.

**[Live demo](https://poncdashphughes.github.io/colglyph-code/)**

ColGlyphCode stores data as a grid of 16 colours. Each cell encodes a 4-bit nibble, and every page is protected by Reed–Solomon error correction, so a glyph survives smudges, glare, slight rotation, and colour-cast lighting. Everything runs in the browser: no server, no connectivity, no app install. (The page loads its typefaces from Google Fonts when online and falls back to system fonts when not; file data never leaves the browser either way.)

From **A4 pages** holding 10-35 KB each (depending on cell density) to **50×30mm labels** holding a few hundred bytes, the same encoding works at every size. Screen targets run from phone-sized frames up to **Desktop QHD (2560×1440)** and **Desktop 4K (3840×2160)**. Files larger than one page split across up to 255 self-identifying pages that can be scanned in any order.

Two capacity multipliers stack on top of the raw grid:

- **Cell density** — Standard (1.5mm cells on A4), Fine (1.0mm, ~2× capacity), Ultra (0.8mm, ~3× capacity). Denser grids need a better printer and a steadier scan; verify a test print before relying on Ultra. On screens, cells never drop below 4 px, so Ultra only differs from Fine on the 4K target.
- **Transparent compression** — files are deflated (browser-native `CompressionStream`) before paging whenever that shrinks them. Text, JSON, CSV and code typically gain 2-6×; already-compressed formats pass through unchanged. The decoder inflates automatically after reassembly.

One hard limit sits above both: the page header stores the payload length as a 16-bit field, so a page carries at most **65,535 bytes (64 KB)** however large its grid. A QHD Fine grid physically holds 82 KB (84,112 bytes); the surplus is padding. With 255 pages, a single file therefore tops out at 255 × 65,535 B ≈ **16 MB**.

## Screen-to-phone transfer (Deck mode)

Deck mode moves a file from any screen to a phone with no network, no pairing and no cable: the presenter shows the encoded pages as a full-screen slideshow, the phone watches through its camera and collects pages until the file reassembles. Nothing crosses the gap except light. The channel is strictly one-way, air-gapped and visible to anyone standing next to it — a transfer a human can watch.

**Presenter (any laptop or desktop browser):**

1. Open the [live demo](https://poncdashphughes.github.io/colglyph-code/), choose **Encode**, and drop in the file.
2. Under *Target Size* pick the **Screen** category and choose **Desktop (1920×1080)** with density **Fine** — the live-scan operating point (468 cells across). If the phone's status strip later reports a camera of 1920×1080 or less, re-encode at **Desktop Standard**. The QHD and 4K targets hold more per slide but exceed what live video can resolve; keep them for still-photo capture. Present scales the glyph to the panel, and it is the cells-across count the camera must resolve, not the glyph's pixel size, so any monitor works.
3. Set the display to full brightness and turn off Night Shift / True Tone / blue-light filters for the duration.
4. Click **Present**. The glyph fills the screen and, for multi-page files, advances every 2 seconds, looping until stopped. Press **Esc** to exit. Where the browser has no element fullscreen (iPhones, some embedded browsers) a full-viewport overlay is used instead; clicking the glyph also exits that.

**Receiver (phone):**

1. Open the live URL in the phone's browser. It must be **HTTPS** — browsers refuse camera access on plain HTTP — which GitHub Pages already is.
2. Choose **Decode**, then **Open Camera** and grant camera permission.
3. Tap **Scan Deck**. Fill the frame with the glyph (roughly 40–60 cm from a desktop monitor), keep the phone steady, and leave the slideshow running.
4. The status strip over the viewfinder shows the camera resolution granted, frames tried, the last decode result and page coverage ("3 / 80 pages — waiting for pages …"). Missed slides come round again on the next loop.
5. Scanning stops by itself at **"Complete — all N pages collected"**. Tap **Download Decoded File**.

**Capacity:** 46,360 bytes per slide at Desktop Fine (468×236 cells), so a 5 MB file is about 113 slides — one full cycle at 2 s per slide takes under four minutes. Desktop Standard (312×157) carries 20,546 bytes per slide. QHD Fine's 65,535-byte slides (80 for 5 MB) are a still-photo capacity, not a live one. Compression counts: a text-heavy file is measured after deflate.

**Caveats, honestly stated:**

- Live scanning decodes video frames, not full-resolution stills, so it has less margin than photographing a page. If the status strip stalls on "no valid decode", drop one density rung on the presenter (Desktop Fine → Desktop Standard) and start again. If the strip reports a camera resolution of 1920×1080 or lower, the phone has granted less than the sensor can deliver; that is the first thing to drop a rung for.
- A file that fits in one page shows a single static glyph. Nothing cycles, and that is correct: scan it like any other glyph.
- Each Scan Deck session starts a fresh collection, and a page from a different file than the one being collected starts over rather than merging. Only pages whose payload checksum verifies are counted, so a blurred frame can never satisfy the page count with corrupt data. After the first decoded slide the grid size is locked for the rest of the session, so later frames skip detection.
- Still photos from an iPhone 15 decode up to QHD Fine. Live video, measured with simulated camera frames (85% frame fill, 1° tilt, clipped whites), decodes Desktop Fine from a 4K camera stream and Desktop Standard from a 1080p one, and never locks QHD Fine at either. A real-phone pass of the live ladder is the next measurement — see [docs/SCREEN-CHANNEL.md](docs/SCREEN-CHANNEL.md).

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
| 8–9 | Payload length this page (u16 — hence the 65,535-byte page cap) |
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

Deck mode's **Scan Deck** loop runs this same pipeline on successive camera frames (the next frame is taken ~400 ms after the previous decode finishes, with a paint between them so the status strip stays live), keeps every page whose checksum verifies, and stops when the page count in the header is satisfied. Photo upload accepts a multi-file selection and decodes every image in the batch.

## Development

```bash
npm install
npm run dev     # dev server on port 3001 (set PORT to change)
npm test        # unit tests (RS codec, ECC plan, binary format)
npm run build   # type-check + production build
```

### Camera testing from a phone

Browsers only expose the camera to secure origins, so a phone on the LAN cannot use Decode against a plain-HTTP dev server. `npm run dev` serves **HTTPS automatically** when `./.dev-certs/key.pem` and `./.dev-certs/cert.pem` exist (the directory is gitignored). Generate a self-signed pair once, with the machine's LAN address in the certificate:

```bash
mkdir -p .dev-certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout .dev-certs/key.pem -out .dev-certs/cert.pem -subj "/CN=colglyph-dev" -addext "subjectAltName=DNS:localhost,IP:<your-lan-ip>"
```

Then run `npm run dev -- --host` so the server listens on the LAN, open `https://<your-lan-ip>:3001/` on the phone and accept the certificate warning once. To force plain HTTP even when the certs exist, run `npx vite --mode http`.

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

Working proof of concept with a usable screen-to-phone demo.

Verified: clean round trips at all shipped media sizes and densities (up to 250×345 grids), recovery from dozens of corrupted cells, compressed multi-page reassembly, simulated camera captures up to 8° rotation with strong colour cast, and byte-level encode/decode across the u16 payload cap on an 885×452 4K Ultra grid. Real-world print-and-scan is verified at Standard density. The screen channel has been measured on an iPhone 15 from still photos: Desktop Standard, Desktop Fine and QHD Fine pass; 4K Ultra fails (the auto-detector locks an aliased sub-lattice). Deck mode — Present, Scan Deck and batch photo decode — shipped on 2026-10-19; the engineering record is in [docs/SCREEN-CHANNEL.md](docs/SCREEN-CHANNEL.md).

Future work:

- **Beam mode** — a fountain-coded animated stream (LT symbols, light per-frame RS, tear detection) so the display can run near camera frame rate instead of a fixed dwell
- **Aliased-lattice detection** — when the auto-detector locks a coarse grid at high confidence, also try integer multiples of it before giving up
- **Confidence gating** — discount reported confidence when the header fails validation, so a garbage decode never reads as 95%
- **Dwell-time control** for Present mode (fixed at 2 s today)
- **Format v1.3** — widen the payload length to u24, or tile independent glyphs across a 4K screen, so large grids stop wasting capacity above 64 KB
- Data masking (QR-style XOR patterns) so sparse *data* doesn't render as mostly-black cells — page padding is already pseudo-random, so a short final page no longer presents as a black field
- Structured-append checksum so pages from different files can't be mixed

## Licence

Dual licence, matching the wider ColourGlyphs project family:

- **Specification** (format, palette, geometry): [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **Software** (encoder, decoder, tools): [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html)

See [LICENCE](LICENCE) for full terms.

Created by **Peter Hughes**.

- Project: [https://poncdashphughes.github.io/colglyph-code/](https://poncdashphughes.github.io/colglyph-code/)
- GitHub: [https://github.com/poncdashphughes/colglyph-code](https://github.com/poncdashphughes/colglyph-code)
- Sibling project: [MediglyphCode](https://github.com/poncdashphughes/mediglyph-code) — the same glyph family applied to emergency medical identification
