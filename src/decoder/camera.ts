/** Camera wrapper for MediaDevices API */
export class CameraManager {
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement;
  private facingMode: 'environment' | 'user' = 'environment';
  private frameCanvas: HTMLCanvasElement | null = null;
  private frameCtx: CanvasRenderingContext2D | null = null;
  /** Called when the OS ends the track (app switch, screen lock, incoming call) */
  onEnded: (() => void) | null = null;

  constructor(videoElement: HTMLVideoElement) {
    this.videoElement = videoElement;
  }

  async start(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'the browser only allows camera access on a secure (https://) page. '
        + 'Open this app over HTTPS — the public site at poncdashphughes.github.io already is.',
      );
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          // Ask for the sensor's best — a QHD Fine deck is 628 cells
          // across and needs every pixel the camera will give us.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      for (const track of this.stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          // Only react to the OS ending a live track — our own stop()
          // nulls the stream first and does not fire this event.
          if (this.stream && this.stream.getVideoTracks().includes(track)) {
            this.stop();
            this.onEnded?.();
          }
        });
      }
      this.videoElement.srcObject = this.stream;
      await this.videoElement.play();
    } catch (err) {
      throw new Error(`Camera access denied: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.videoElement.srcObject = null;
  }

  async switchCamera(): Promise<void> {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    this.stop();
    await this.start();
  }

  /**
   * Draw the current video frame into a canvas. The canvas is reused
   * between calls (a 4K frame is ~33 MB — allocating one per scan tick
   * is what pushes iOS Safari into jettisoning the tab), so callers
   * must not hold on to it across frames.
   */
  captureFrame(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const w = this.videoElement.videoWidth;
    const h = this.videoElement.videoHeight;
    if (!this.frameCanvas || !this.frameCtx) {
      this.frameCanvas = document.createElement('canvas');
      this.frameCtx = this.frameCanvas.getContext('2d', { willReadFrequently: true })!;
    }
    if (this.frameCanvas.width !== w || this.frameCanvas.height !== h) {
      this.frameCanvas.width = w;
      this.frameCanvas.height = h;
    }
    this.frameCtx.drawImage(this.videoElement, 0, 0);
    return { canvas: this.frameCanvas, ctx: this.frameCtx };
  }

  get isActive(): boolean {
    return !!this.stream;
  }

  /** Actual delivered video resolution — what the OS granted, not what we asked for */
  get resolution(): { width: number; height: number } | null {
    const w = this.videoElement.videoWidth;
    const h = this.videoElement.videoHeight;
    return w > 0 ? { width: w, height: h } : null;
  }
}
