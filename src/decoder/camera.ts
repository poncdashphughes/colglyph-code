/** Camera wrapper for MediaDevices API */
export class CameraManager {
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement;
  private facingMode: 'environment' | 'user' = 'environment';

  constructor(videoElement: HTMLVideoElement) {
    this.videoElement = videoElement;
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
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

  captureFrame(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = document.createElement('canvas');
    canvas.width = this.videoElement.videoWidth;
    canvas.height = this.videoElement.videoHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(this.videoElement, 0, 0);
    return { canvas, ctx };
  }

  get isActive(): boolean {
    return !!this.stream;
  }
}
