/**
 * CanvasStage: owns the play canvas size and the animation loop.
 *
 * The canvas always matches the viewport. Its backing store is CSS size × dpr,
 * with dpr capped at 2 and lowered for very large screens so a frame never
 * exceeds ~9 M device pixels (keeps fill-rate sane on integrated GPUs).
 * Resizes are coalesced and applied at the start of the next frame, so a
 * resized canvas is never shown blank.
 */

import type { Stage } from '../types';

const MAX_DPR = 2;
const REDUCED_DPR = 1.5;
const MAX_DEVICE_PIXELS = 9_000_000;
const MAX_DT = 0.05;

/** Device-pixel ratio to render at for a CSS viewport size. */
export function chooseDpr(cssWidth: number, cssHeight: number, deviceRatio: number): number {
  let dpr = Math.min(deviceRatio > 0 && Number.isFinite(deviceRatio) ? deviceRatio : 1, MAX_DPR);
  const area = cssWidth * cssHeight;
  if (area * dpr * dpr > MAX_DEVICE_PIXELS) dpr = Math.min(dpr, REDUCED_DPR);
  // Ultra-wide / 5K-class viewports: fall back to 1× rather than drop frames.
  if (area * dpr * dpr > MAX_DEVICE_PIXELS) dpr = Math.min(dpr, 1);
  return dpr;
}

type ResizeListener = (width: number, height: number, dpr: number) => void;

export class CanvasStage implements Stage {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private cssW = 0;
  private cssH = 0;
  private ratio = 1;
  private raf = 0;
  private last = 0;
  private dirty = false;
  private pendingMeasure = 0;
  private frame: ((dt: number, now: number) => void) | null = null;
  private readonly listeners = new Set<ResizeListener>();
  private observer: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private watchedRatio = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('KeySplash needs a 2D canvas');
    this.ctx = ctx;
    this.measure();

    window.addEventListener('resize', this.handleViewportChange, { passive: true });
    window.addEventListener('orientationchange', this.handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', this.handleViewportChange, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.handleViewportChange);
      this.observer.observe(document.documentElement);
    }
  }

  get width(): number {
    return this.cssW;
  }

  get height(): number {
    return this.cssH;
  }

  get dpr(): number {
    return this.ratio;
  }

  start(frame: (dt: number, now: number) => void): void {
    this.frame = frame;
    if (this.raf) return; // already running: just adopt the latest callback
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  onResize(listener: ResizeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Removes every listener and stops the loop. */
  dispose(): void {
    this.stop();
    if (this.pendingMeasure) cancelAnimationFrame(this.pendingMeasure);
    this.pendingMeasure = 0;
    window.removeEventListener('resize', this.handleViewportChange);
    window.removeEventListener('orientationchange', this.handleViewportChange);
    window.visualViewport?.removeEventListener('resize', this.handleViewportChange);
    this.observer?.disconnect();
    this.observer = null;
    this.dprQuery?.removeEventListener?.('change', this.handleViewportChange);
    this.dprQuery = null;
    this.listeners.clear();
  }

  private readonly tick = (now: number): void => {
    // Schedule first so one bad frame can't stop the toy.
    this.raf = requestAnimationFrame(this.tick);
    if (this.dirty) {
      this.dirty = false;
      this.measure();
    }
    let dt = this.last ? (now - this.last) / 1000 : 1 / 60;
    this.last = now;
    if (!(dt > 0)) dt = 0;
    else if (dt > MAX_DT) dt = MAX_DT;
    this.frame?.(dt, now);
  };

  private readonly handleViewportChange = (): void => {
    this.dirty = true;
    // When the loop is idle, apply it on the next animation frame anyway.
    if (!this.raf && !this.pendingMeasure) {
      this.pendingMeasure = requestAnimationFrame(() => {
        this.pendingMeasure = 0;
        if (this.dirty) {
          this.dirty = false;
          this.measure();
        }
      });
    }
  };

  private measure(): void {
    const doc = document.documentElement;
    const cssW = Math.max(1, Math.round(window.innerWidth || doc.clientWidth || this.canvas.clientWidth || 1));
    const cssH = Math.max(1, Math.round(window.innerHeight || doc.clientHeight || this.canvas.clientHeight || 1));
    const dpr = chooseDpr(cssW, cssH, window.devicePixelRatio || 1);
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    this.watchDpr();
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.ratio && this.canvas.width === pw && this.canvas.height === ph) {
      return;
    }
    this.cssW = cssW;
    this.cssH = cssH;
    this.ratio = dpr;
    const style = this.canvas.style;
    style.width = `${cssW}px`;
    style.height = `${cssH}px`;
    this.canvas.width = pw;
    this.canvas.height = ph;
    // Resizing resets context state: restore the CSS-pixel transform.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const listener of this.listeners) listener(cssW, cssH, dpr);
  }

  /** Re-measure when the window moves to a screen with a different pixel ratio. */
  private watchDpr(): void {
    const ratio = window.devicePixelRatio || 1;
    if (ratio === this.watchedRatio || typeof window.matchMedia !== 'function') return;
    this.dprQuery?.removeEventListener?.('change', this.handleViewportChange);
    this.watchedRatio = ratio;
    this.dprQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
    this.dprQuery.addEventListener?.('change', this.handleViewportChange);
  }
}
