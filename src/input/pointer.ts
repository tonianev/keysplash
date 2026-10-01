/**
 * Pointer input (mouse, touch, pen) on the play canvas, with multi-touch and
 * the parent's escape hatch: hold the top-left corner still for a few seconds.
 */
import type { PointerHandlers, PointerInput } from '../types';

const DEFAULT_CORNER_SIZE = 80; // CSS px
const DEFAULT_CORNER_HOLD_MS = 2500;
/** A corner hold is cancelled if the finger wanders further than this from where it started. */
const CORNER_SLOP_PX = 24;
const CORNER_TICK_MS = 50;
/** Ten fingers plus some slack; protects against pointers whose `up` never arrived. */
const MAX_POINTERS = 16;

interface TrackedPointer {
  x: number;
  y: number;
}

interface CornerHold {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
}

export interface DomPointerInputOptions {
  cornerSize?: number;
  cornerHoldMs?: number;
}

export class DomPointerInput implements PointerInput {
  private readonly el: HTMLElement;
  private readonly handlers: PointerHandlers;
  private readonly cornerSize: number;
  private readonly cornerHoldMs: number;
  private readonly pointers = new Map<number, TrackedPointer>();
  private corner: CornerHold | null = null;
  private cornerTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = 0;
  private hoverX = Number.NaN;
  private hoverY = Number.NaN;
  private attached = false;
  private enabled = true;
  private previousTouchAction = '';

  constructor(el: HTMLElement, handlers: PointerHandlers, options: DomPointerInputOptions = {}) {
    this.el = el;
    this.handlers = handlers;
    this.cornerSize = positiveOr(options.cornerSize, DEFAULT_CORNER_SIZE);
    this.cornerHoldMs = positiveOr(options.cornerHoldMs, DEFAULT_CORNER_HOLD_MS);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    // No browser panning/zooming on the play surface, so pointers are never cancelled mid-drag.
    this.previousTouchAction = this.el.style.touchAction;
    this.el.style.touchAction = 'none';
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    this.el.addEventListener('lostpointercapture', this.onUp);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.el.style.touchAction = this.previousTouchAction;
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('lostpointercapture', this.onUp);
    this.reset();
  }

  /** While disabled no handlers fire; active pointers and any corner hold are dropped. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  private reset(): void {
    this.cancelCorner();
    this.pointers.clear();
    this.hoverX = Number.NaN;
    this.hoverY = Number.NaN;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const id = e.pointerId;
    const x = e.clientX;
    const y = e.clientY;
    try {
      this.el.setPointerCapture(id);
    } catch {
      // Synthetic or already-released pointers can't be captured; tracking still works.
    }
    if (!this.pointers.has(id) && this.pointers.size >= MAX_POINTERS) {
      const oldest = this.pointers.keys().next();
      if (!oldest.done) this.forget(oldest.value);
    }
    this.pointers.set(id, { x, y });
    if (this.corner === null && x <= this.cornerSize && y <= this.cornerSize) {
      this.startCorner(id, x, y);
    }
    this.handlers.onTap(x, y, id);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const x = e.clientX;
    const y = e.clientY;
    const p = this.pointers.get(e.pointerId);
    if (p) {
      const dx = x - p.x;
      const dy = y - p.y;
      p.x = x;
      p.y = y;
      const c = this.corner;
      if (c && c.pointerId === e.pointerId && Math.hypot(x - c.startX, y - c.startY) > CORNER_SLOP_PX) {
        this.cancelCorner();
      }
      this.handlers.onDrag(x, y, dx, dy, e.pointerId);
      return;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const dx = Number.isNaN(this.hoverX) ? 0 : x - this.hoverX;
      const dy = Number.isNaN(this.hoverY) ? 0 : y - this.hoverY;
      this.hoverX = x;
      this.hoverY = y;
      this.handlers.onHover(x, y, dx, dy);
    }
  };

  /** pointerup, pointercancel and lostpointercapture all end a pointer (whichever comes first wins). */
  private readonly onUp = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const id = e.pointerId;
    const p = this.pointers.get(id);
    if (!p) return;
    this.forget(id);
    // lostpointercapture can carry (0, 0); fall back to the last known spot.
    const useLast = e.type === 'lostpointercapture';
    const x = useLast ? p.x : e.clientX;
    const y = useLast ? p.y : e.clientY;
    if (e.pointerType === 'mouse') {
      this.hoverX = x;
      this.hoverY = y;
    }
    this.handlers.onRelease(x, y, id);
  };

  private forget(id: number): void {
    this.pointers.delete(id);
    if (this.corner?.pointerId === id) this.cancelCorner();
  }

  private startCorner(pointerId: number, x: number, y: number): void {
    this.corner = { pointerId, startX: x, startY: y, startTime: performance.now() };
    this.cornerTimer = setInterval(this.tickCorner, CORNER_TICK_MS);
  }

  private readonly tickCorner = (): void => {
    const c = this.corner;
    if (!c) return;
    const progress = Math.min(1, (performance.now() - c.startTime) / this.cornerHoldMs);
    this.setProgress(progress);
    if (progress >= 1) {
      // Done: stop tracking this hold (the pointer itself stays a normal pointer).
      this.stopCornerTimer();
      this.corner = null;
      this.handlers.onCornerHold();
      this.setProgress(0);
    }
  };

  private stopCornerTimer(): void {
    if (this.cornerTimer !== null) {
      clearInterval(this.cornerTimer);
      this.cornerTimer = null;
    }
  }

  private cancelCorner(): void {
    this.stopCornerTimer();
    this.corner = null;
    this.setProgress(0);
  }

  private setProgress(progress: number): void {
    if (progress === this.lastProgress) return;
    this.lastProgress = progress;
    this.handlers.onCornerProgress?.(progress);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
