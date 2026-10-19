# The Screen Channel — digital but still offline

Status: **Deck mode shipped 2026-10-19** (channel results measured
2026-08-06). Companion to the v1.2 format in [README.md](../README.md),
which carries the user-facing steps; this file is the engineering
record and the roadmap for the Beam mode that follows.

## Why

A printed A4 page tops out around 35 KB (Ultra density). The physics of
ink and paper cap it near a few hundred KB no matter how hard the format
works, because a page is a single static frame in a noisy spatial
channel. A display is a far better medium on both axes:

- **Cleaner spatial channel** — emissive, flat, rigid, uniform, with a
  known pixel grid. No dot gain, no halftoning, no ambient-light
  dependence. Cells that need 0.8 mm of paper need a handful of pixels.
- **A temporal dimension** — a screen can show many glyphs in sequence.
  Capacity stops being bounded by area and becomes bounded by time.

The transfer stays **offline and air-gapped**: nothing crosses the gap
except photons. Unlike a USB stick (a bidirectional device with firmware),
a screen-to-camera link is a strictly one-way channel a human can watch.
That property is the point, and it should stay a headline of the design.

Target that motivated this: **move a 5 MB file to an iPhone with no
network** — impossible on one printed page, comfortable on a screen.

## Mode A — Deck (static slideshow; works with format v1.2) — SHIPPED

Encode the file with the existing multi-page mechanism (self-identifying
pages, any order, ≤ 255 pages), then *display* the pages as an
auto-advancing slideshow instead of printing them. The phone watches the
screen and accumulates pages until the file reassembles. Missed a slide?
It comes round again on the next cycle — order and completeness were
already solved by the v1.2 page model.

Per-page payloads from `pagePayloadCapacity` (re-computed against the
code on 2026-10-19; screen cells floor at 4 px, so Ultra equals Fine
below 4K):

| Media          | Density  | Grid      | Cell    | Payload/page |
|----------------|----------|-----------|---------|--------------|
| desktop 1080p  | Standard | 312×157   | 6 px    | 20,546 B     |
| desktop 1080p  | Fine     | 468×236   | 4 px    | 46,360 B     |
| desktop-qhd    | Standard | 418×213   | 6 px    | 37,367 B     |
| desktop-qhd    | Fine     | 628×319   | 4 px    | 65,535 B (u16 cap; grid holds 84,112) |
| desktop-4k     | Standard | 472×241   | 8 px    | 47,748 B     |
| desktop-4k     | Fine     | 708×361   | 5.33 px | 65,535 B (u16 cap; grid holds 107,319) |
| desktop-4k     | Ultra    | 885×452   | 4.27 px | 65,535 B (u16 cap; grid holds 167,981) |

5 MB at 64 KB/page ≈ **80 slides** (81 for 5 MiB). At the shipped 2 s
dwell that is under three minutes per cycle, hands-free.

### What shipped (src/main.ts, src/decoder/camera.ts)

1. **Presenter** — a Present button appears once a file is encoded. It
   requests element fullscreen on the glyph canvas (`object-fit:
   contain` on white, so the quiet zone survives any aspect ratio) and
   cycles pages every `PRESENT_DWELL_MS` = 2000 ms while more than one
   page exists. Browsers without element fullscreen (iPhones), browsers
   that reject the request, and embedded browsers that *accept the
   request but never enter fullscreen and never reject it* all fall
   back to a fixed full-viewport overlay — the last case is caught by a
   400 ms engagement check after the click. Esc exits; in overlay mode
   clicking the glyph exits too.
2. **Continuous capture (Scan Deck)** — a chained loop grabs a frame
   from the live stream and runs the existing decode pipeline on it
   (direct decode, then preprocess-and-retry), taking the next frame
   ~400 ms after the previous decode finishes with a paint hop between
   them, so a multi-second first decode cannot freeze the HUD or the
   Stop button. Pages accumulate in the same store photo upload uses,
   deduplicated by page number; only pages whose payload CRC verifies
   are kept, and a page whose header names a different file restarts
   the collection instead of merging. After the first valid decode the
   grid dimensions are held as a session-local lattice lock so later
   frames skip detection (every slide in a deck shares one grid); the
   lock, the collection and the HUD counters reset each time a scan
   session starts. Scanning stops itself once every page number below
   `totalPages` has been collected, and scrolls the download button
   into view.
3. **HUD** — a status strip over the viewfinder reports the camera
   resolution the OS actually granted (`videoWidth × videoHeight`, not
   what was requested), frames tried, the last decode note (page
   decoded, or grid/confidence of the failed attempt, or the pipeline
   error string), page coverage with the list of pages still missing,
   and finally "Complete — all N pages collected".
4. **Camera request** — `getUserMedia` now asks for an ideal 3840×2160
   (was 1280×720). What is granted is phone- and browser-dependent and
   is the first number to read when a scan stalls.
5. **Batch photo decode** — a multi-file selection decodes every image
   and reports "k of n photos decoded" (previously only `files[0]` was
   read).
6. **Dev HTTPS** — `vite.config.ts` serves HTTPS when
   `.dev-certs/{key,cert}.pem` exist (gitignored), because iOS refuses
   `getUserMedia` on plain HTTP; `vite --mode http` forces HTTP. The
   public GitHub Pages deployment is HTTPS already.

Format constraints respected (v1.2, unchanged):

- Header bytes 8–9 carry payload length as **u16**, so a page never
  claims more than 65,535 B even when a 4K grid could hold more.
  `pagePayloadCapacity` clamps to 0xFFFF and `encodeFile` pads each page
  to the ECC plan's data size rather than to the clamped capacity, so
  oversized grids no longer corrupt (regression test: 150 KB across
  three clamped 4K Ultra pages round-trips).
- 255 pages × 65,535 B = 16,711,425 B ≈ **16 MB file ceiling** for Deck
  under v1.2.

## Mode B — Beam (animated fountain stream; format work required)

Deck's slide dwell time must be long enough for the *worst* frame the
camera grabs. Beam removes that coupling: stream glyph frames
continuously and make frame loss free, so the display can run near the
camera's rate.

Design sketch, informed by the decimen-optical-transfer reference
(screen-to-camera animated QR + LT fountain, measured 128 KB/s
phone-to-phone with monochrome QR):

- **Erasure layer: LT fountain code** (robust soliton). The file is K
  blocks; each displayed frame carries one fountain symbol; any
  ~K×1.15 distinct symbols in any order reconstruct the file. Torn,
  blurred, or missed frames simply don't count. Non-obvious portability
  lesson from the reference implementation: derive the soliton
  distribution with *deterministic* float math so every JS engine builds
  identical symbol compositions.
- **Corruption layer: light RS per frame.** In-frame ECC handles pixel
  misreads; the fountain handles whole-frame loss. Two failure modes,
  two codes — per-frame parity can therefore be lighter than the 16%
  print profile.
- **Frame layout:** colour data grid plus a frame-ID stripe at top *and*
  bottom (mismatched stripes ⇒ rolling-shutter tear ⇒ discard frame) and
  a palette calibration strip (True Tone / Night Shift / brightness
  drift make screen colour non-stationary).
- **Rates:** symbol rate ≤ half the camera frame rate (30 fps capture ⇒
  ≤ 15 symbols/s). A QHD-Fine-sized colour frame carries ~50 KB; even at
  5 clean symbols/s that is ~250 KB/s goodput — 5 MB in ~20 s. Colour
  cells at full-screen density are the differentiator over QR streams.
- **Hazards & mitigations:** moiré (avoid 1–2 px cells; slight defocus
  helps), iOS auto-exposure/focus hunting (lock via getUserMedia
  constraints where allowed), display PWM flicker (prefer max
  brightness), decode budget (the per-frame sampler needs a WASM/WebGPU
  path at these grid sizes — the shipped Scan Deck loop already runs
  the full JS pipeline per frame at 2 Hz, which is the baseline to beat).

Beam is *not* v1.2-compatible: it needs a frame container (session id,
K, block size, symbol seed) in place of the page header. Treat it as a
sibling format sharing the palette, sampler, and RS codec.

Reference implementation note: decimen-optical-transfer (MIT) is a
useful reference for the fountain layer and capture loop. Port ideas and
bring its test vectors; do not take it as a dependency without a
line-by-line review — unknown-author repo.

## Density-ladder test

Everything above hangs on one measured number: the smallest on-screen
cell the iPhone classifies reliably. The ladder:

1. Encode a ~20 KB random-bytes file at `desktop` Standard (6 px cells).
   Display full-screen (100% zoom, max brightness, True Tone/Night Shift
   off for the first pass — then repeat with them on to measure the
   cost).
2. Decode with the iPhone from ~40–60 cm. Record: decode success, RS
   corrections used, confidence, attempts needed.
3. Step down: 6 px → 4 px (Fine) → QHD Fine → 4K Ultra (4.27 px), same
   file, same procedure. Note where corrections start climbing and where
   decode fails — the knee, not the cliff, sets the operating point.
4. Repeat the operating-point rung under: hand-held vs propped phone,
   indoor evening light, and an off-axis angle (~15°). The worst of
   these is the Deck default density; one rung safer is the conservative
   preset.

Record results in this file. RS corrections-per-page is the number that
sizes Beam's per-frame parity, so keep the raw counts, not just
pass/fail.

### Results — first ladder run (2026-08-06, iPhone 15 photo → upload)

Capture method: native Camera app photo of the glyph on screen, uploaded
to the dev-server decode page. (Live camera was blocked at the time
because the dev server was plain HTTP; the HTTPS dev-cert path and the
GitHub Pages deployment have since removed that obstacle.)

| Rung | Grid | Result |
|---|---|---|
| Desktop Standard (6 px) | 312×157 | **Clean pass** — valid header, CRC valid, no ECC repairs reported, compressed payload round-tripped (real 7.5 KB file recovered) |
| Desktop Fine (4 px) | 468×236 | **Pass** (reported 2026-08-06; repair counts not captured — re-run worth logging) |
| QHD Fine (4 px) | 628×319 | **Pass** (reported 2026-08-06; repair counts not captured) |
| 4K Ultra (4.27 px) | 885×452 | **Hard fail** — auto-detect locked an aliased ÷3.77 sub-lattice (235×120 at "95% confidence"); with dims forced via the hint fields the rectifier aligned perfectly (data bounds at exact 32 px quiet zone) and ECC repaired 5,248 bytes, but 323 RS blocks stayed beyond repair |

Reading: since the phone frames the glyph either way, the operative
variable is **cells across the frame**, not cell px. The knee sits
between 628 cols (passes) and 885 cols (collapses) — conveniently right
where the format's u16 page cap already bites. **Still-photo operating
point: QHD Fine — 628×319, 64 KB/page, 5 MB in ~80 slides.** Live
capture is tighter — see the live ladder below. Conservative preset:
Desktop Fine (468 cols, 45 KB/page). Untested rung: 4K Fine
(708 cols) sits inside the knee and gains nothing under the u16 cap, so
it is not worth probing until v1.3 lifts the cap.

### Results — live Scan Deck ladder (2026-10-19, simulated camera frames)

Run against the shipped Scan Deck loop with a synthetic camera: each
slide drawn at 85% of the frame width with a 1° tilt on a mid-grey
background, whites clipped at 255, slides cycling every 2 s, fed to the
page through `canvas.captureStream()` in place of `getUserMedia`. A real
phone frame is worse (optical blur, 4:2:0 chroma, hand shake), so treat
passes as upper bounds and fails as firm.

| Presenter rung | Cells across | Camera stream | Result |
|---|---|---|---|
| QHD Fine | 628 | 3840×2160 | **Fail** — 45 frames in 90 s, never locked (aliased 240×135 / 116×63 grids) |
| Desktop Fine | 468 | 3840×2160 | **Pass** — 3 pages in 6.1 s (after the padding fix below; 2 of 3 in 60 s before it) |
| Desktop Standard | 312 | 3840×2160 | **Pass** — 5 pages in 10.2 s |
| Desktop Fine | 468 | 1920×1080 | **Marginal** — 2 of 3 pages in 60 s |
| Desktop Standard | 312 | 1920×1080 | **Pass** — 5 pages in 9.4 s |

**Live operating point: Desktop Fine (468 cols, 46,360 B/slide) when
the phone grants a 4K stream; Desktop Standard (312 cols, 20,546
B/slide) when it grants 1080p.** QHD Fine remains a still-photo
capacity. 5 MB is ~113 slides at Desktop Fine (under four minutes per
cycle at 2 s dwell) and ~250 at Desktop Standard — right against the
255-page cap, which is the practical argument for Beam.

The padding discovery: a file's final page is mostly padding, and
padding was zero bytes — a field of black cells that lattice refinement
cannot lock onto. Desktop Fine at 4K decoded pages 1 and 2 within
seconds and never page 3. Padding is now a deterministic pseudo-random
sequence (decoders ignore it; the header's payload length bounds what
is kept), and the same rung completed in 6 s. No format change: v1.2
decoders read the new pages unchanged.

Still to measure: the same ladder on a real phone, with the HUD's
granted-resolution and "last:" fields making the run self-documenting.

Decoder notes from the run:

- Grid auto-detection is the first casualty at high density: it locks
  aliased sub-lattices with high confidence. The brute-force search
  should also try integer multiples of any high-confidence coarse lock
  (235×120 × 3.77 ≈ 885×452 was recoverable here). **Open.**
- The reported confidence must be discounted when the header is invalid
  — 95–100% confidence appeared on both garbage decodes. **Open.**
- Perspective rectification of screen photos works well — good news for
  Deck's capture loop (borne out: Scan Deck reuses it unchanged).
- The decode upload only read the first file of a multi-selection.
  **Fixed** — batch upload decodes every image.
- `normaliseWhiteBalance` skipped pure-white pixels (meant to exclude
  the warp's synthetic border), so a perfectly exposed or clipped quiet
  zone — a bright monitor on camera — left only anti-aliased cell edges
  to sample and applied a ~1.3× gain that failed every decode. Still
  photos escaped it because iPhone HDR keeps screen whites just below
  255; live video frames clip readily. **Fixed 2026-10-19** — the
  sampler now takes a geometric ring beyond the warp inset and keeps
  white. Found in pre-release review; the most likely reason the first
  live-scan attempt saw nothing while uploaded photos decoded.

## Roadmap

1. **Channel probe** — DONE 2026-08-06 (results above). Operating point:
   QHD Fine, 64 KB/page.
2. **Deck v1** — SHIPPED 2026-10-19: Present (fullscreen with overlay
   fallback, 2 s dwell), Scan Deck (live continuous capture, HUD,
   lattice lock, auto-stop), batch photo upload, 3840×2160 camera
   request, QHD/4K media targets, u16 clamp fix, HTTPS dev server.
   Still open: a real-device **live-scan** run at Desktop Fine with
   repair counts logged (the simulated ladder above is the current
   evidence), and a **dwell-time control** in the UI.
3. **Decoder hardening** — integer-multiple retry for aliased lattice
   locks; confidence gating on header validity.
4. **Beam v1** — fountain frame format, tear detection, WASM sampler.
   Target ≥ 250 KB/s sustained.
5. **Format v1.3 (if Deck wastes too much 4K grid)** — widen payload
   length to u24, or tile 2×4 independent glyphs per 4K screen to reuse
   the u16 page model unchanged.
