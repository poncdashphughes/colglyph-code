import './styles/global.css';
import type { MediaSize, GlyphLayout, DecodedResult } from './core/types';
import { PALETTE } from './core/palette';
import { PAPER_SIZES, SCREEN_SIZES } from './core/media-sizes';
import { createLayout } from './core/glyph-layout';
import {
  encodeFile,
  reassembleFile,
  pagePayloadCapacity,
  type EncodedPage,
  type DecodedPageInfo,
} from './core/binary';
import { renderGlyph } from './encoder/glyph-renderer';
import { downloadPNG, downloadSVG, copyHexData, downloadFile } from './encoder/export';
import { compressBytes, decompressBytes } from './core/compress';
import { decodeFromImage } from './decoder/decode-pipeline';
import { preprocessFrame } from './decoder/preprocess';
import { CameraManager } from './decoder/camera';

// ── Density Levels ──
interface DensityLevel {
  id: string;
  label: string;
  /** Multiplier applied to each media size's minimum cell size */
  scale: number;
  hint: string;
}

const DENSITIES: DensityLevel[] = [
  { id: 'standard', label: 'Standard', scale: 1, hint: 'Largest cells — most robust for printing and scanning' },
  { id: 'fine', label: 'Fine', scale: 2 / 3, hint: '~2× capacity — needs a decent printer and a steady scan' },
  { id: 'ultra', label: 'Ultra', scale: 8 / 15, hint: '~3× capacity — verify a test print before relying on it' },
];

// ── State ──
let selectedMedia: MediaSize = PAPER_SIZES[0]; // default A4
let selectedDensity: DensityLevel = DENSITIES[0];
let currentLayout: GlyphLayout = createLayout(selectedMedia, selectedDensity.scale);
/** Original file bytes as uploaded */
let rawBytes: Uint8Array | null = null;
/** Bytes actually encoded — deflated when compression wins */
let fileBytes: Uint8Array | null = null;
let isCompressed = false;
let fileName = '';
let encodedPages: EncodedPage[] = [];
let currentPage = 0;
let label = '';
let encodeError = '';

let decoderImageCanvas: HTMLCanvasElement | null = null;
let decoderImageCtx: CanvasRenderingContext2D | null = null;
let decodedPages: DecodedPageInfo[] = [];
let camera: CameraManager | null = null;

const $ = (id: string) => document.getElementById(id)!;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  initHero();
  initTabs();
  initMediaSelector();
  initDensitySelector();
  initFileUpload();
  initExportButtons();
  initDecoder();
  initPageNav();
  updatePreviewInfo();
  updateCapacity();
  renderCurrentPage();
});

// ── Hero ──
function initHero() {
  const hero = $('heroSection');
  const app = $('appWrapper');

  const showApp = (tab: 'encoder' | 'decoder') => {
    hero.classList.add('hidden');
    app.classList.add('visible');
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', (t as HTMLElement).dataset.tab === tab);
    });
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $(`${tab}View`).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  $('heroEncode').addEventListener('click', () => showApp('encoder'));
  $('heroDecode').addEventListener('click', () => showApp('decoder'));
}

// ── Tabs ──
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = (tab as HTMLElement).dataset.tab!;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      $(`${target}View`).classList.add('active');

      if (target !== 'decoder' && camera?.isActive) {
        camera.stop();
        $('cameraSection').style.display = 'none';
        $('toggleCamera').textContent = 'Open Camera';
        $('captureBtn').style.display = 'none';
        $('switchCamera').style.display = 'none';
      }
    });
  });
}

// ── Media Size Selector ──
function initMediaSelector() {
  const tabsContainer = $('mediaCategoryTabs');
  const grid = $('mediaSizeGrid');

  const categories = [
    { id: 'paper', label: 'Paper', sizes: PAPER_SIZES },
    { id: 'screen', label: 'Screen', sizes: SCREEN_SIZES },
  ];

  let activeCategory = 'paper';

  function renderTabs() {
    tabsContainer.innerHTML = '';
    categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = `media-category-tab${cat.id === activeCategory ? ' active' : ''}`;
      btn.textContent = cat.label;
      btn.addEventListener('click', () => {
        activeCategory = cat.id;
        renderTabs();
        renderGrid();
      });
      tabsContainer.appendChild(btn);
    });
  }

  function renderGrid() {
    grid.innerHTML = '';
    const sizes = categories.find(c => c.id === activeCategory)!.sizes;

    sizes.forEach(size => {
      const layout = createLayout(size, selectedDensity.scale);
      const payloadCap = pagePayloadCapacity(layout);
      const card = document.createElement('div');
      card.className = `media-size-card${size.id === selectedMedia.id ? ' selected' : ''}`;

      const unit = size.category === 'paper' ? 'mm' : 'px';
      const capText = payloadCap > 0 ? `${formatBytes(payloadCap)} data` : 'too small';
      card.innerHTML = `
        <div class="media-size-name">${size.name}</div>
        <div class="media-size-dims">${size.width} x ${size.height} ${unit}</div>
        <div class="media-size-capacity">${layout.cols}x${layout.rows} grid &bull; ${capText}</div>
      `;

      card.addEventListener('click', () => {
        selectedMedia = size;
        currentLayout = createLayout(size, selectedDensity.scale);
        renderGrid();
        reEncode();
        updatePreviewInfo();
      });

      grid.appendChild(card);
    });
  }

  renderTabs();
  renderGrid();
  refreshMediaGrid = renderGrid;
}

/** Re-render the media size cards (capacities depend on density) */
let refreshMediaGrid: () => void = () => {};

// ── Density Selector ──
function initDensitySelector() {
  const tabs = $('densityTabs');
  const hint = $('densityHint');

  function render() {
    tabs.innerHTML = '';
    DENSITIES.forEach(d => {
      const btn = document.createElement('button');
      btn.className = `media-category-tab${d.id === selectedDensity.id ? ' active' : ''}`;
      btn.textContent = d.label;
      btn.addEventListener('click', () => {
        selectedDensity = d;
        currentLayout = createLayout(selectedMedia, d.scale);
        render();
        refreshMediaGrid();
        reEncode();
        updatePreviewInfo();
      });
      tabs.appendChild(btn);
    });
    hint.textContent = selectedDensity.hint;
  }

  render();
}

// ── File Upload ──
function initFileUpload() {
  const dropZone = $('fileDropZone');
  const fileInput = $('fileInput') as HTMLInputElement;
  const labelInput = $('glyphLabel') as HTMLInputElement;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file) loadFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) loadFile(file);
  });

  labelInput.addEventListener('input', () => {
    label = labelInput.value;
    renderCurrentPage();
  });
}

function loadFile(file: File) {
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = async () => {
    rawBytes = new Uint8Array(reader.result as ArrayBuffer);

    // Compress transparently when it actually shrinks the file —
    // already-compressed formats (JPEG, ZIP) pass through unchanged
    isCompressed = false;
    fileBytes = rawBytes;
    try {
      const deflated = await compressBytes(rawBytes);
      if (deflated && deflated.length < rawBytes.length * 0.95) {
        fileBytes = deflated;
        isCompressed = true;
      }
    } catch { /* no compression support — encode raw */ }

    reEncode();
    updatePreviewInfo();
  };
  reader.readAsArrayBuffer(file);
}

function reEncode() {
  encodeError = '';

  if (!fileBytes) {
    encodedPages = [];
    currentPage = 0;
    renderCurrentPage();
    return;
  }

  try {
    encodedPages = encodeFile(fileBytes, fileName, currentLayout, { compressed: isCompressed });
  } catch (err) {
    encodedPages = [];
    encodeError = (err as Error).message;
  }
  currentPage = 0;
  renderCurrentPage();
  updatePageNav();
  updateFileInfo();
  updateCapacity();
}

function renderCurrentPage() {
  const canvas = $('glyphCanvas') as HTMLCanvasElement;

  if (encodedPages.length === 0) {
    // Render empty grid as preview
    const emptyBytes = new Array(currentLayout.capacityBytes).fill(0x00);
    renderGlyph(canvas, emptyBytes, null, currentLayout, label || undefined);
    return;
  }

  const page = encodedPages[currentPage];
  renderGlyph(canvas, page.bytes, page.meta, currentLayout, label || undefined);
}

// ── Page Navigation ──
function initPageNav() {
  $('prevPage').addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage--;
      renderCurrentPage();
      updatePageNav();
    }
  });

  $('nextPage').addEventListener('click', () => {
    if (currentPage < encodedPages.length - 1) {
      currentPage++;
      renderCurrentPage();
      updatePageNav();
    }
  });
}

function updatePageNav() {
  const nav = $('pageNav');
  const allBtn = $('downloadAllPng');

  if (encodedPages.length > 1) {
    nav.style.display = 'flex';
    allBtn.style.display = '';
    $('pageLabel').textContent = `Page ${currentPage + 1} / ${encodedPages.length}`;
  } else {
    nav.style.display = 'none';
    allBtn.style.display = 'none';
  }
}

// ── Info Displays ──
function updateFileInfo() {
  const info = $('fileInfo');
  if (!fileBytes || !rawBytes) {
    info.classList.remove('visible');
    return;
  }

  info.classList.add('visible');
  $('fileName').textContent = fileName;
  $('fileSize').textContent = isCompressed
    ? `${formatBytes(rawBytes.length)} → ${formatBytes(fileBytes.length)} compressed`
    : formatBytes(rawBytes.length);
  $('filePages').textContent = encodeError
    ? encodeError
    : `${encodedPages.length} page${encodedPages.length !== 1 ? 's' : ''} at ${selectedMedia.name} (${selectedDensity.label.toLowerCase()})`;
}

function updateCapacity() {
  const fill = $('capacityFill') as HTMLElement;
  const text = $('capacityText');
  const payloadCap = pagePayloadCapacity(currentLayout);

  if (encodeError) {
    fill.style.width = '100%';
    fill.className = 'capacity-fill error';
    text.textContent = encodeError;
    return;
  }

  if (!fileBytes) {
    fill.style.width = '0%';
    fill.className = 'capacity-fill';
    text.textContent = payloadCap > 0
      ? `Capacity: ${formatBytes(payloadCap)} per page (with error correction)`
      : 'This media size is too small for a glyph';
    return;
  }

  const pct = Math.min(100, (fileBytes.length / (payloadCap * Math.max(1, encodedPages.length))) * 100);
  fill.style.width = `${pct}%`;
  fill.className = 'capacity-fill' + (pct >= 100 ? ' error' : pct >= 80 ? ' warning' : '');
  const sizeText = isCompressed
    ? `${formatBytes(fileBytes.length)} (compressed)`
    : formatBytes(fileBytes.length);
  text.textContent = `${sizeText} / ${formatBytes(payloadCap)} per page (${encodedPages.length} page${encodedPages.length !== 1 ? 's' : ''})`;
}

function updatePreviewInfo() {
  const info = $('previewInfo');
  const unit = selectedMedia.category === 'paper' ? 'mm' : 'px';
  const payloadCap = pagePayloadCapacity(currentLayout);
  info.innerHTML = `
    <strong>Size:</strong> ${selectedMedia.width} x ${selectedMedia.height} ${unit} &nbsp;|&nbsp;
    <strong>Grid:</strong> ${currentLayout.cols} x ${currentLayout.rows} &nbsp;|&nbsp;
    <strong>Capacity:</strong> ${formatBytes(payloadCap)} per page
  `;
}

// ── Export Buttons ──
function initExportButtons() {
  $('downloadPng').addEventListener('click', () => {
    const canvas = $('glyphCanvas') as HTMLCanvasElement;
    const safeName = fileName ? fileName.replace(/[^a-zA-Z0-9.-]/g, '-') : 'colglyph';
    const suffix = encodedPages.length > 1 ? `-p${currentPage + 1}` : '';
    downloadPNG(canvas, `${safeName}${suffix}.png`);
  });

  $('downloadSvg').addEventListener('click', () => {
    if (encodedPages.length === 0) return;
    const safeName = fileName ? fileName.replace(/[^a-zA-Z0-9.-]/g, '-') : 'colglyph';
    const suffix = encodedPages.length > 1 ? `-p${currentPage + 1}` : '';
    const page = encodedPages[currentPage];
    downloadSVG(page.bytes, page.meta, currentLayout, label || undefined, `${safeName}${suffix}.svg`);
  });

  $('downloadAllPng').addEventListener('click', () => {
    const safeName = fileName ? fileName.replace(/[^a-zA-Z0-9.-]/g, '-') : 'colglyph';
    const canvas = document.createElement('canvas');
    for (let i = 0; i < encodedPages.length; i++) {
      renderGlyph(canvas, encodedPages[i].bytes, encodedPages[i].meta, currentLayout, label || undefined);
      const link = document.createElement('a');
      link.download = `${safeName}-p${i + 1}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }
  });

  $('copyHex').addEventListener('click', async () => {
    if (encodedPages.length === 0) return;
    await copyHexData(encodedPages[currentPage].bytes);
    const btn = $('copyHex');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Hex'; }, 1500);
  });
}

// ── Decoder ──
function initDecoder() {
  const dropZone = $('decodeDropZone');
  const fileInput = $('decodeFileInput') as HTMLInputElement;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) loadDecodeImages(files);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) loadDecodeImages(fileInput.files);
  });

  $('decodeBtn').addEventListener('click', () => {
    if (decoderImageCanvas && decoderImageCtx) {
      const hintCols = parseInt(($('hintCols') as HTMLInputElement).value) || undefined;
      const hintRows = parseInt(($('hintRows') as HTMLInputElement).value) || undefined;

      // Try direct decode first
      let result = decodeFromImage(decoderImageCanvas, decoderImageCtx, hintCols, hintRows);

      // If direct decode fails, try with preprocessing (image might be a photo)
      if (!result.pageInfo?.valid) {
        const corrected = preprocessFrame(decoderImageCanvas);
        if (corrected) {
          const ppResult = decodeFromImage(corrected.canvas, corrected.ctx, hintCols, hintRows);
          if (ppResult.pageInfo?.valid || ppResult.confidence > result.confidence) {
            result = ppResult;
            // Update preview to show corrected image
            ($('decodePreviewImg') as HTMLImageElement).src = corrected.canvas.toDataURL();
          }
        }
      }

      if (result.pageInfo?.valid) {
        const pageInfo = result.pageInfo;
        const existing = decodedPages.findIndex(p => p.page === pageInfo.page);
        if (existing >= 0) {
          decodedPages[existing] = pageInfo;
        } else {
          decodedPages.push(pageInfo);
        }
      }
      displayDecodedData(result);
    }
  });

  $('toggleCamera').addEventListener('click', toggleCamera);
  $('captureBtn').addEventListener('click', captureFromCamera);
  $('switchCamera').addEventListener('click', () => camera?.switchCamera());

  $('downloadDecoded').addEventListener('click', async () => {
    if (decodedPages.length === 0) return;
    const assembled = reassembleFile(decodedPages);
    if (assembled.bytes.length === 0) return;

    let bytes = assembled.bytes;
    if (assembled.compressed) {
      if (!assembled.complete) {
        alert(`Compressed file needs all pages before it can be decompressed (${assembled.pagesReceived} of ${assembled.totalPages} scanned).`);
        return;
      }
      try {
        bytes = await decompressBytes(bytes);
      } catch {
        alert('Decompression failed — one or more pages may have decoded incorrectly.');
        return;
      }
    }
    downloadFile(bytes, assembled.filename || 'decoded-file');
  });
}

function loadDecodeImages(files: FileList) {
  decodedPages = [];

  // Load first image for preview
  const file = files[0];
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      ($('decodePreviewImg') as HTMLImageElement).src = img.src;
      $('uploadedPreview').classList.add('visible');
      $('decodeBtn').style.display = 'block';

      decoderImageCanvas = document.createElement('canvas');
      decoderImageCanvas.width = img.width;
      decoderImageCanvas.height = img.height;
      decoderImageCtx = decoderImageCanvas.getContext('2d')!;
      decoderImageCtx.drawImage(img, 0, 0);
    };
    img.src = reader.result as string;
  };
  reader.readAsDataURL(file);
}

async function toggleCamera() {
  const section = $('cameraSection');
  const btn = $('toggleCamera');

  if (camera?.isActive) {
    camera.stop();
    section.style.display = 'none';
    btn.textContent = 'Open Camera';
    $('captureBtn').style.display = 'none';
    $('switchCamera').style.display = 'none';
  } else {
    try {
      const video = $('cameraVideo') as HTMLVideoElement;
      camera = new CameraManager(video);
      await camera.start();
      section.style.display = 'block';
      btn.textContent = 'Close Camera';
      $('captureBtn').style.display = '';
      $('switchCamera').style.display = '';
    } catch (err) {
      alert(`Camera error: ${(err as Error).message}`);
    }
  }
}

function captureFromCamera() {
  if (!camera?.isActive) return;

  const { canvas: rawCanvas } = camera.captureFrame();

  // Preprocess: find glyph, correct perspective, normalise colour
  const corrected = preprocessFrame(rawCanvas);
  if (corrected) {
    decoderImageCanvas = corrected.canvas;
    decoderImageCtx = corrected.ctx;
  } else {
    // Preprocessing couldn't find a glyph — try raw frame
    decoderImageCanvas = rawCanvas;
    decoderImageCtx = rawCanvas.getContext('2d')!;
  }

  ($('decodePreviewImg') as HTMLImageElement).src = decoderImageCanvas.toDataURL();
  $('uploadedPreview').classList.add('visible');
  $('decodeBtn').style.display = 'block';

  const result = decodeFromImage(decoderImageCanvas, decoderImageCtx);
  if (result.pageInfo?.valid) {
    const pageInfo = result.pageInfo;
    const existing = decodedPages.findIndex(p => p.page === pageInfo.page);
    if (existing >= 0) {
      decodedPages[existing] = pageInfo;
    } else {
      decodedPages.push(pageInfo);
    }
  }
  displayDecodedData(result);
}

async function displayDecodedData(decoded: DecodedResult) {
  const output = $('decodedOutput');
  output.classList.add('visible');

  const pageInfo = decoded.pageInfo;

  // For compressed payloads the raw text is gibberish — inflate for the
  // preview once every page has been collected
  let previewText = decoded.text;
  let previewLabel = 'Text Preview';
  if (pageInfo?.valid && pageInfo.compressed) {
    previewText = '';
    const assembled = reassembleFile(decodedPages);
    if (assembled.complete && assembled.bytes.length > 0) {
      try {
        const inflated = await decompressBytes(assembled.bytes);
        previewText = new TextDecoder('utf-8', { fatal: false }).decode(inflated.slice(0, 400));
        previewLabel = 'Text Preview (decompressed)';
      } catch { /* leave preview empty */ }
    }
  }

  $('decodedName').textContent = pageInfo?.filename || 'Unknown file';

  const metaParts: string[] = [];
  if (pageInfo?.fileSize) metaParts.push(`Size: ${formatBytes(pageInfo.fileSize)}`);
  metaParts.push(`Grid: ${decoded.cols} x ${decoded.rows}`);
  metaParts.push(`Confidence: ${Math.round(decoded.confidence * 100)}%`);
  if (pageInfo?.valid && pageInfo.totalPages) {
    metaParts.push(`Page ${pageInfo.page + 1} / ${pageInfo.totalPages}`);
  }
  $('decodedMeta').textContent = metaParts.join(' • ');

  const details = $('decodedDetails');
  details.innerHTML = '';

  if (decoded.error) {
    details.innerHTML += `
      <div class="decoded-detail" style="border-left: 3px solid #D92626;">
        <div class="decoded-detail-label">Error</div>
        <div class="decoded-detail-value">${decoded.error}</div>
      </div>
    `;
  }

  // Validity, checksum, error correction
  if (pageInfo) {
    const valid = pageInfo.valid ? 'Valid ColGlyph header' : 'Invalid header';
    const crc = pageInfo.checksumValid ? 'CRC valid' : 'CRC mismatch';
    let eccBadge = '';
    if (pageInfo.compressed) {
      eccBadge += `<span class="confidence-badge medium">Compressed</span>`;
    }
    if (pageInfo.correctedBytes > 0) {
      eccBadge += `<span class="confidence-badge medium">ECC repaired ${pageInfo.correctedBytes} byte${pageInfo.correctedBytes !== 1 ? 's' : ''}</span>`;
    }
    if (pageInfo.failedBlocks > 0) {
      eccBadge += `<span class="confidence-badge low">${pageInfo.failedBlocks} block${pageInfo.failedBlocks !== 1 ? 's' : ''} beyond repair</span>`;
    }
    details.innerHTML += `
      <div class="decoded-detail">
        <div class="decoded-detail-label">Header</div>
        <div class="decoded-detail-value">
          <span class="confidence-badge ${pageInfo.valid ? 'high' : 'low'}">${valid}</span>
          <span class="confidence-badge ${pageInfo.checksumValid ? 'high' : 'low'}">${crc}</span>
          ${eccBadge}
        </div>
      </div>
    `;
    if (pageInfo.filename) {
      details.innerHTML += `
        <div class="decoded-detail">
          <div class="decoded-detail-label">Filename</div>
          <div class="decoded-detail-value">${pageInfo.filename}</div>
        </div>
      `;
    }
    if (pageInfo.valid && pageInfo.totalPages > 1) {
      details.innerHTML += `
        <div class="decoded-detail">
          <div class="decoded-detail-label">Pages collected</div>
          <div class="decoded-detail-value">${decodedPages.length} of ${pageInfo.totalPages}</div>
        </div>
      `;
    }
  }

  // Hex preview (first 128 bytes)
  if (decoded.hex) {
    const preview = decoded.hex.split(' ').slice(0, 128).join(' ');
    details.innerHTML += `
      <div class="decoded-detail">
        <div class="decoded-detail-label">Payload Hex (first 128 bytes)</div>
        <div class="decoded-detail-value" style="font-family: var(--font-mono); font-size: 0.75rem;">${preview}${decoded.bytes.length > 128 ? ' ...' : ''}</div>
      </div>
    `;
  }

  // Text preview
  if (previewText) {
    const textPreview = previewText.substring(0, 200);
    details.innerHTML += `
      <div class="decoded-detail">
        <div class="decoded-detail-label">${previewLabel}</div>
        <div class="decoded-detail-value">${escapeHtml(textPreview)}${previewText.length > 200 ? '...' : ''}</div>
      </div>
    `;
  }

  // Show download button if valid
  const dlBtn = $('downloadDecoded');
  dlBtn.style.display = pageInfo?.valid ? 'block' : 'none';

  // Debug
  $('debugPre').textContent = JSON.stringify(
    { ...decoded, bytes: `${decoded.bytes.length} bytes`, pageInfo: pageInfo ? { ...pageInfo, payload: `${pageInfo.payload.length} bytes` } : undefined },
    null,
    2,
  );
  $('decodeDebug').classList.add('visible');
}

// ── Utilities ──
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Browser Test Harness (callable from console) ──
// These exercise the full pixel pipeline, which unit tests can't reach
// from Node. Each returns a structured result for assertions.

const TEST_TEXT = 'Hello ColGlyph! The quick brown fox jumps over the lazy dog 0123456789.';

interface HarnessResult {
  ok: boolean;
  valid: boolean;
  checksumValid: boolean;
  textMatches: boolean;
  correctedBytes: number;
  failedBlocks: number;
  cols: number;
  rows: number;
  expectedCols: number;
  expectedRows: number;
  confidence: number;
  error?: string;
}

function summarise(result: DecodedResult, layout: GlyphLayout, expectedText: string): HarnessResult {
  const pi = result.pageInfo;
  const text = result.text.substring(0, expectedText.length);
  const r: HarnessResult = {
    ok: !!pi?.valid && !!pi?.checksumValid && text === expectedText,
    valid: !!pi?.valid,
    checksumValid: !!pi?.checksumValid,
    textMatches: text === expectedText,
    correctedBytes: pi?.correctedBytes ?? 0,
    failedBlocks: pi?.failedBlocks ?? 0,
    cols: result.cols,
    rows: result.rows,
    expectedCols: layout.cols,
    expectedRows: layout.rows,
    confidence: Number(result.confidence.toFixed(3)),
    error: result.error,
  };
  return r;
}

function renderTestGlyph(mediaId: string, withLabel?: string, density = 1): { canvas: HTMLCanvasElement; layout: GlyphLayout } | null {
  const media = [...PAPER_SIZES, ...SCREEN_SIZES].find(m => m.id === mediaId);
  if (!media) { console.error('Unknown media:', mediaId); return null; }
  const layout = createLayout(media, density);
  const testData = new TextEncoder().encode(TEST_TEXT);
  const pages = encodeFile(testData, 'test.txt', layout);
  const canvas = document.createElement('canvas');
  renderGlyph(canvas, pages[0].bytes, pages[0].meta, layout, withLabel);
  return { canvas, layout };
}

/** Clean render → decode round trip (no camera simulation) */
(window as any).testRoundTrip = function (mediaId = 'business-card', withLabel?: string, density = 1): HarnessResult | null {
  const g = renderTestGlyph(mediaId, withLabel, density);
  if (!g) return null;
  const ctx = g.canvas.getContext('2d')!;
  const result = decodeFromImage(g.canvas, ctx);
  return summarise(result, g.layout, TEST_TEXT);
};

/** Compression round trip: deflate → encode → render → decode → inflate */
(window as any).testCompressed = async function (mediaId = 'a6', density = 1) {
  const media = [...PAPER_SIZES, ...SCREEN_SIZES].find(m => m.id === mediaId);
  if (!media) return null;
  const layout = createLayout(media, density);
  const text = TEST_TEXT.repeat(40);
  const raw = new TextEncoder().encode(text);
  const deflated = await compressBytes(raw);
  if (!deflated) return { ok: false, error: 'CompressionStream unavailable' };

  const pages = encodeFile(deflated, 'test.txt', layout, { compressed: true });
  const canvas = document.createElement('canvas');
  renderGlyph(canvas, pages[0].bytes, pages[0].meta, layout);
  const result = decodeFromImage(canvas, canvas.getContext('2d')!);
  const pi = result.pageInfo;
  if (!pi?.valid || !pi.checksumValid) {
    return { ok: false, valid: !!pi?.valid, crc: !!pi?.checksumValid };
  }
  const assembled = reassembleFile([pi]);
  const inflated = await decompressBytes(assembled.bytes);
  const out = new TextDecoder().decode(inflated);
  return {
    ok: out === text && pi.compressed && assembled.compressed,
    compressedFlag: pi.compressed,
    rawLen: raw.length,
    deflatedLen: deflated.length,
    ratio: (raw.length / deflated.length).toFixed(1) + 'x',
  };
};

/** Render, corrupt N random data cells with wrong colours, then decode */
(window as any).testCorruption = function (mediaId = 'business-card', nCells = 20): HarnessResult | null {
  const g = renderTestGlyph(mediaId);
  if (!g) return null;
  const { canvas, layout } = g;
  const ctx = canvas.getContext('2d')!;

  const palette = ['#000000', '#D92626', '#E8D31A', '#1A8C5A', '#2E6FBF', '#7D3DAD'];
  const total = layout.cols * layout.rows;
  const chosen = new Set<number>();
  while (chosen.size < Math.min(nCells, total)) {
    chosen.add(Math.floor(Math.random() * total));
  }
  for (const idx of chosen) {
    const row = Math.floor(idx / layout.cols);
    const col = idx % layout.cols;
    ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)];
    ctx.fillRect(
      layout.dataZoneX + col * layout.cellSize,
      layout.dataZoneY + row * layout.cellSize,
      layout.cellSize,
      layout.cellSize,
    );
  }

  const result = decodeFromImage(canvas, ctx);
  return summarise(result, layout, TEST_TEXT);
};

/** Simulated camera photo: dark background, scale, rotation, colour cast */
(window as any).testCameraCapture = function (
  mediaId = 'business-card',
  rotationDeg = 0,
  colorCast: [number, number, number] = [1.0, 0.98, 0.92],
  scale = 0.7,
  density = 1,
): HarnessResult | null {
  const g = renderTestGlyph(mediaId, undefined, density);
  if (!g) return null;
  const { canvas: glyphCanvas, layout } = g;

  const photoW = 1280;
  const photoH = 720;
  const photoCanvas = document.createElement('canvas');
  photoCanvas.width = photoW;
  photoCanvas.height = photoH;
  const photoCtx = photoCanvas.getContext('2d')!;

  // Clamp scale so the whole glyph fits in the simulated photo
  scale = Math.min(scale, (photoW * 0.9) / glyphCanvas.width, (photoH * 0.9) / glyphCanvas.height);

  // Dark background (simulating desk/table)
  photoCtx.fillStyle = '#2a2a2a';
  photoCtx.fillRect(0, 0, photoW, photoH);

  // Draw glyph centered, scaled, rotated
  const rad = rotationDeg * Math.PI / 180;
  photoCtx.save();
  photoCtx.translate(photoW / 2, photoH / 2);
  photoCtx.rotate(rad);
  photoCtx.scale(scale, scale);
  photoCtx.drawImage(glyphCanvas, -glyphCanvas.width / 2, -glyphCanvas.height / 2);
  photoCtx.restore();

  // Apply colour cast
  const imgData = photoCtx.getImageData(0, 0, photoW, photoH);
  for (let i = 0; i < imgData.data.length; i += 4) {
    imgData.data[i] = Math.min(255, Math.round(imgData.data[i] * colorCast[0]));
    imgData.data[i + 1] = Math.min(255, Math.round(imgData.data[i + 1] * colorCast[1]));
    imgData.data[i + 2] = Math.min(255, Math.round(imgData.data[i + 2] * colorCast[2]));
  }
  photoCtx.putImageData(imgData, 0, 0);

  // Preprocess + decode
  const corrected = preprocessFrame(photoCanvas);
  if (!corrected) {
    return {
      ok: false, valid: false, checksumValid: false, textMatches: false,
      correctedBytes: 0, failedBlocks: 0, cols: 0, rows: 0,
      expectedCols: layout.cols, expectedRows: layout.rows, confidence: 0,
      error: 'Preprocessing failed — no glyph found',
    };
  }

  const result = decodeFromImage(corrected.canvas, corrected.ctx);
  return summarise(result, layout, TEST_TEXT);
};

/** Diagnostic: locate cells whose sampled colour disagrees with what was rendered */
(window as any).testDiag = function (mediaId = 'business-card') {
  const g = renderTestGlyph(mediaId);
  if (!g) return null;
  const { canvas, layout } = g;
  const ctx = canvas.getContext('2d')!;
  const result = decodeFromImage(canvas, ctx);
  const dbg = result.debug as { dataBounds: { minX: number; minY: number; maxX: number; maxY: number }; cellWidth: number };

  // Expected nibble stream
  const media = [...PAPER_SIZES, ...SCREEN_SIZES].find(m => m.id === mediaId)!;
  const testData = new TextEncoder().encode(TEST_TEXT);
  const pages = encodeFile(testData, 'test.txt', createLayout(media));
  const expected: number[] = [];
  for (const b of pages[0].bytes) { expected.push((b >> 4) & 0xF, b & 0xF); }
  while (expected.length < layout.capacityCells) expected.push(14);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { minX, minY, maxX, maxY } = dbg.dataBounds;
  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const cellSize = Math.min(contentW / result.cols, contentH / result.rows);
  const startX = minX + (contentW - result.cols * cellSize) / 2;
  const startY = minY + (contentH - result.rows * cellSize) / 2;

  const rowHist: Record<number, number> = {};
  const colHist: Record<number, number> = {};
  const firstMismatches: Array<{ row: number; col: number; want: number; got: number; rgb: number[] }> = [];
  let mismatches = 0;

  const samplePx = (x: number, y: number) => {
    const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };

  for (let row = 0; row < result.rows; row++) {
    for (let col = 0; col < result.cols; col++) {
      const idx = row * result.cols + col;
      const cx = startX + (col + 0.5) * cellSize;
      const cy = startY + (row + 0.5) * cellSize;
      const rgb = samplePx(cx, cy);
      const m = matchToPaletteForDiag(rgb);
      if (m !== expected[idx]) {
        mismatches++;
        rowHist[row] = (rowHist[row] || 0) + 1;
        colHist[col] = (colHist[col] || 0) + 1;
        if (firstMismatches.length < 15) firstMismatches.push({ row, col, want: expected[idx], got: m, rgb });
      }
    }
  }

  return {
    mediaId,
    dims: `${result.cols}x${result.rows}`,
    layoutCell: layout.cellSize,
    decodedCell: cellSize,
    dataBounds: dbg.dataBounds,
    layoutDataZone: { x: layout.dataZoneX, y: layout.dataZoneY },
    gridStart: { x: startX, y: startY },
    mismatches,
    worstRows: Object.entries(rowHist).sort((a, b) => b[1] - a[1]).slice(0, 6),
    worstCols: Object.entries(colHist).sort((a, b) => b[1] - a[1]).slice(0, 6),
    firstMismatches,
  };
};

function matchToPaletteForDiag(rgb: number[]): number {
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const p = PALETTE[i].rgb;
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Battery of round-trip, corruption, camera, density, and compression tests */
(window as any).testAll = async function (): Promise<Record<string, unknown>> {
  const t = window as any;
  const FINE = 2 / 3;
  const ULTRA = 8 / 15;
  return {
    'roundtrip:a4': t.testRoundTrip('a4'),
    'roundtrip:a6': t.testRoundTrip('a6'),
    'roundtrip:business-card': t.testRoundTrip('business-card'),
    'roundtrip:label-large': t.testRoundTrip('label-large'),
    'roundtrip:square-md': t.testRoundTrip('square-md'),
    'roundtrip:desktop': t.testRoundTrip('desktop'),
    'roundtrip:label:a5': t.testRoundTrip('a5', 'MY HOLIDAY PHOTOS'),
    'rt-fine:a4': t.testRoundTrip('a4', undefined, FINE),
    'rt-ultra:a4': t.testRoundTrip('a4', undefined, ULTRA),
    'rt-ultra:business-card': t.testRoundTrip('business-card', undefined, ULTRA),
    'corrupt20:business-card': t.testCorruption('business-card', 20),
    'corrupt40:a6': t.testCorruption('a6', 40),
    'camera0:business-card': t.testCameraCapture('business-card', 0),
    'camera2:business-card': t.testCameraCapture('business-card', 2),
    'camera3:a6': t.testCameraCapture('a6', 3),
    'cam-fine2:label-large': t.testCameraCapture('label-large', 2, undefined, 0.7, FINE),
    'compressed:a6': await t.testCompressed('a6'),
    'compressed-ultra:a4': await t.testCompressed('a4', ULTRA),
  };
};
