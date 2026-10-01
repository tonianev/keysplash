/**
 * Pre-rendered sprites. Anything with text, gradients, outlines or shadows is
 * rendered ONCE to an offscreen canvas here and then blitted per frame with
 * drawImage + setTransform. Caches are bounded LRUs (count and byte budget).
 *
 * Nothing in this module touches the DOM at import time, so the pure pieces
 * (LruCache, ColorTable, size buckets) are unit-testable without a canvas.
 */

import type { NamedColor, ShapeKind } from '../types';
import { lighten, darken, mix, toRgba } from './color';

/** Paints a shape body centred on (0,0) — shapes.ts `drawShape` in production. */
export type ShapePainter = (ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number, color: NamedColor, dark: boolean) => void;

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

interface LruEntry<V> {
  value: V;
  cost: number;
}

/**
 * Least-recently-used cache bounded by entry count and (optionally) by a total
 * cost such as bytes. `get` refreshes recency. The newest entry is always kept,
 * even when it alone exceeds the cost budget.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, LruEntry<V>>();
  private totalCost = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxCost: number = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get cost(): number {
    return this.totalCost;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Re-insert to mark as most recently used (Map keeps insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, cost = 1): void {
    const old = this.map.get(key);
    if (old) {
      this.totalCost -= old.cost;
      this.map.delete(key);
    }
    this.map.set(key, { value, cost });
    this.totalCost += cost;
    this.evict();
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.totalCost -= entry.cost;
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalCost = 0;
  }

  /** Keys from least to most recently used (for tests/debugging). */
  keys(): K[] {
    return [...this.map.keys()];
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || (this.totalCost > this.maxCost && this.map.size > 1)) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Colour table: small integer ids for colours, so particles can store a byte
// ---------------------------------------------------------------------------

export class ColorTable {
  private readonly hexes: string[] = [];
  private readonly ids = new Map<string, number>();
  private readonly lightIds: Int16Array;
  private readonly pinned: Uint8Array;
  private nextSlot = 0;
  /** Called when a slot is recycled for a new colour (sprites must drop it). */
  onRecycle: ((id: number) => void) | null = null;

  /** Ids are stored in Uint8Arrays by particles, so capacity must stay ≤ 256. */
  constructor(readonly capacity = 128) {
    this.lightIds = new Int16Array(capacity).fill(-1);
    this.pinned = new Uint8Array(capacity);
  }

  get size(): number {
    return this.hexes.length;
  }

  /**
   * Id for a colour, registering it on first sight. When full, slots are
   * recycled round-robin, skipping pinned ones (white, the current palette).
   */
  id(hex: string): number {
    const known = this.ids.get(hex);
    if (known !== undefined) return known;
    let slot: number;
    if (this.hexes.length < this.capacity) {
      slot = this.hexes.length;
      this.hexes.push(hex);
    } else {
      slot = this.nextSlot;
      for (let tries = 0; tries < this.capacity && this.pinned[slot]; tries++) slot = (slot + 1) % this.capacity;
      this.nextSlot = (slot + 1) % this.capacity;
      this.ids.delete(this.hexes[slot]);
      this.hexes[slot] = hex;
      this.pinned[slot] = 0;
      // Any colour whose light variant lived in this slot must recompute it.
      for (let i = 0; i < this.capacity; i++) if (this.lightIds[i] === slot) this.lightIds[i] = -1;
      this.lightIds[slot] = -1;
      this.onRecycle?.(slot);
    }
    this.ids.set(hex, slot);
    return slot;
  }

  hex(id: number): string {
    return this.hexes[id] ?? '#ffffff';
  }

  /** Protects a colour from being recycled while it is in use. */
  pin(id: number, pinned = true): void {
    if (id >= 0 && id < this.capacity) this.pinned[id] = pinned ? 1 : 0;
  }

  /** Id of a pale tint of `id` (cached). */
  light(id: number): number {
    const cached = this.lightIds[id];
    if (cached >= 0 && cached < this.hexes.length) return cached;
    const lid = this.id(lighten(this.hex(id), 0.5));
    this.lightIds[id] = lid;
    return lid;
  }
}

// ---------------------------------------------------------------------------
// Size buckets: sprites are rendered at ~8% geometric steps and scaled by
// at most ±4% when drawn, so many similar sizes share one sprite.
// ---------------------------------------------------------------------------

const BUCKET_LOG_STEP = Math.log(1.08);

export function sizeBucketIndex(px: number): number {
  return Math.round(Math.log(px > 1 ? px : 1) / BUCKET_LOG_STEP);
}

export function sizeBucketPx(index: number): number {
  return Math.exp(index * BUCKET_LOG_STEP);
}

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

export interface Sprite {
  readonly canvas: HTMLCanvasElement;
  /** Drawn size in CSS px (at the bucket size). */
  readonly w: number;
  readonly h: number;
  /** Anchor (visual centre of the main ink) in CSS px from the top-left. */
  readonly ax: number;
  readonly ay: number;
  /** Nominal size the sprite was rendered for: font px, or radius for shapes. */
  readonly size: number;
  /** Hit radius around the anchor, CSS px. */
  readonly radius: number;
  /** Ink half-extents around the anchor (conservative), CSS px. */
  readonly halfW: number;
  readonly halfH: number;
}

/** Particle / effect sprite kinds (one small canvas per kind × colour). */
export const SPR_GLOW = 0;
export const SPR_BUBBLE = 1;
export const SPR_PETAL = 2;
export const SPR_CONFETTI = 3;
export const SPR_STAR = 4;
export const SPR_LEAF = 5;
export const SPR_TAIL = 6;
const SPRITE_KINDS = 7;

/** Glow sprites are mostly halo: draw them this many times the dot size. */
export const GLOW_SPAN = 2.8;

export const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Largest sprite edge in device px; bigger sprites render at reduced resolution. */
const MAX_SPRITE_DEVICE_PX = 1600;
const MB = 1024 * 1024;

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Thrown when a canvas context can't be created (e.g. iOS canvas-memory cap). */
class CanvasUnavailable extends Error {}

function get2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new CanvasUnavailable('2D canvas unavailable');
  return ctx;
}

/** A deep, slightly purple shade of a colour, used for outlines on light worlds. */
export function deepShade(hex: string): string {
  return mix(hex, '#2a1740', 0.6);
}

interface TextBox {
  left: number;
  right: number;
  ascent: number;
  descent: number;
  width: number;
}

function measure(ctx: CanvasRenderingContext2D, text: string, px: number, fallbackAscent: number): TextBox {
  const m = ctx.measureText(text);
  let left = m.actualBoundingBoxLeft;
  let right = m.actualBoundingBoxRight;
  let ascent = m.actualBoundingBoxAscent;
  let descent = m.actualBoundingBoxDescent;
  // Older engines lack actualBoundingBox*: approximate from the advance width.
  if (!Number.isFinite(left) || !Number.isFinite(right) || left + right <= 0) {
    left = 0;
    right = m.width;
  }
  if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent + descent <= 0) {
    ascent = px * fallbackAscent;
    descent = px * 0.06;
  }
  return { left, right, ascent, descent, width: m.width };
}

/**
 * Renders and caches every sprite the scene uses. One instance per scene.
 * Sprites already handed out stay valid after eviction (objects keep a
 * reference); the cache only stops remembering them.
 */
export class SpriteFactory {
  readonly colors = new ColorTable(128);

  // Budgets keep total canvas memory modest (iOS Safari caps it at ~384 MB).
  private readonly glyphs = new LruCache<string, Sprite>(64, 48 * MB);
  private readonly captions = new LruCache<string, Sprite>(96, 20 * MB);
  private readonly emojis = new LruCache<string, Sprite>(128, 24 * MB);
  private readonly shapes = new LruCache<string, Sprite>(64, 48 * MB);
  private readonly particles: (HTMLCanvasElement | null)[];
  private blankCanvas: HTMLCanvasElement | null = null;

  private dpr = 1;
  private fontFamily: string;
  private fontReady = false;
  private fontLoading = false;

  private scratchA: HTMLCanvasElement | null = null;
  private scratchB: HTMLCanvasElement | null = null;

  constructor(
    fontFamily: string,
    private readonly paintShape: ShapePainter,
  ) {
    this.fontFamily = fontFamily;
    this.particles = new Array<HTMLCanvasElement | null>(SPRITE_KINDS * this.colors.capacity).fill(null);
    this.colors.onRecycle = (id) => {
      for (let k = 0; k < SPRITE_KINDS; k++) this.particles[k * this.colors.capacity + id] = null;
    };
  }

  setDpr(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    // Keys include dpr, so old entries could never hit again: free them now.
    this.glyphs.clear();
    this.captions.clear();
    this.emojis.clear();
    this.shapes.clear();
  }

  setFontFamily(fontFamily: string): void {
    if (fontFamily === this.fontFamily) return;
    this.fontFamily = fontFamily;
    this.fontReady = false;
    this.fontLoading = false;
    this.glyphs.clear();
    this.captions.clear();
  }

  /** Drops every cached big sprite and the scratch canvases (memory pressure). */
  releaseCaches(): void {
    this.glyphs.clear();
    this.captions.clear();
    this.emojis.clear();
    this.shapes.clear();
    this.scratchA = null;
    this.scratchB = null;
  }

  // -- glyphs ---------------------------------------------------------------

  /**
   * Letter/number sprite: gradient fill (lighter top), glossy highlight, thick
   * rounded outline with a little 3D rim, soft drop shadow. `px` is the font
   * size in CSS px.
   */
  glyph(text: string, color: NamedColor, px: number, dark: boolean): Sprite {
    const bucket = sizeBucketIndex(px);
    const ready = this.ensureFont();
    const key = `${text}|${color.hex}|${bucket}|${this.dpr}|${dark ? 1 : 0}|${ready ? 1 : 0}`;
    const hit = this.glyphs.get(key);
    if (hit) return hit;
    const size = sizeBucketPx(bucket);
    const sprite = this.safely(size, () => this.renderGlyph(text, color.hex, size, dark));
    this.glyphs.set(key, sprite, sprite.canvas.width * sprite.canvas.height * 4);
    return sprite;
  }

  /**
   * Caption word (white with a deep outline) shown under a letter. Cached on
   * its own so letters with rotating words share one glyph sprite.
   */
  caption(text: string, color: NamedColor, px: number): Sprite {
    const bucket = sizeBucketIndex(px);
    const ready = this.ensureFont();
    const key = `${text}|${color.hex}|${bucket}|${this.dpr}|${ready ? 1 : 0}`;
    const hit = this.captions.get(key);
    if (hit) return hit;
    const size = sizeBucketPx(bucket);
    const sprite = this.safely(size, () => this.renderCaption(text, color.hex, size));
    this.captions.set(key, sprite, sprite.canvas.width * sprite.canvas.height * 4);
    return sprite;
  }

  /** True once the glyph font is usable; kicks off loading otherwise. */
  private ensureFont(): boolean {
    if (this.fontReady) return true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.check !== 'function') {
      this.fontReady = true;
      return true;
    }
    const spec = `700 64px ${this.fontFamily}`;
    let ok = true;
    try {
      ok = fonts.check(spec);
    } catch {
      ok = true;
    }
    if (ok) {
      this.fontReady = true;
      return true;
    }
    if (!this.fontLoading) {
      this.fontLoading = true;
      const family = this.fontFamily;
      const done = () => {
        if (family !== this.fontFamily) return;
        this.fontReady = true;
        this.fontLoading = false;
        // Sprites rendered with the fallback font are re-rendered on next use.
        this.glyphs.clear();
        this.captions.clear();
      };
      fonts.load(spec).then(done, done);
    }
    return false;
  }

  private renderGlyph(text: string, hex: string, px: number, dark: boolean): Sprite {
    const font = `700 ${px}px ${this.fontFamily}`;
    const deep = deepShade(hex);
    const outline = dark ? '#ffffff' : deep;
    const rim = dark ? mix('#c9cdf0', hex, 0.3) : darken(deep, 0.35);
    const lw = px * 0.13; // outline stroke width (half shows outside the ink)
    const ext = px * 0.05; // 3D rim depth
    const blur = px * 0.05;
    const offY = px * 0.05;

    const probe = this.scratch('A', 4, 4);
    probe.ctx.font = font;
    const g = measure(probe.ctx, text, px, 0.72);
    const gw = g.left + g.right;
    const gh = g.ascent + g.descent;

    const pad = blur * 2 + offY + 3;
    const inkW = gw + lw;
    const inkH = gh + lw + ext;
    const W = inkW + pad * 2;
    const H = inkH + pad * 2;
    const rs = Math.min(this.dpr, MAX_SPRITE_DEVICE_PX / Math.max(W, H));
    const wd = Math.ceil(W * rs);
    const hd = Math.ceil(H * rs);

    const ax = W / 2;
    const inkTop = pad + lw / 2;
    const ay = inkTop + gh / 2;
    const x0 = ax - (g.right - g.left) / 2;
    const y0 = inkTop + g.ascent;

    // Layer B: the fill alone (gradient + glossy highlight clipped to the ink).
    const fill = this.scratch('B', wd, hd);
    const fc = fill.ctx;
    fc.setTransform(rs, 0, 0, rs, 0, 0);
    fc.font = font;
    fc.textAlign = 'left';
    fc.textBaseline = 'alphabetic';
    const grad = fc.createLinearGradient(0, y0 - g.ascent, 0, y0 + g.descent);
    grad.addColorStop(0, lighten(hex, 0.38));
    grad.addColorStop(0.55, hex);
    grad.addColorStop(1, darken(hex, 0.12));
    fc.fillStyle = grad;
    fc.fillText(text, x0, y0);
    fc.globalCompositeOperation = 'source-atop';
    const hx = ax - gw * 0.16;
    const hy = inkTop + gh * 0.22;
    const shine = fc.createRadialGradient(hx, hy, 0, hx, hy, Math.max(gw, gh) * 0.5);
    shine.addColorStop(0, 'rgba(255,255,255,0.5)');
    shine.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    fc.fillStyle = shine;
    fc.fillRect(0, 0, W, H);
    fc.globalCompositeOperation = 'source-over';

    // Layer A: 3D rim + outline, then the fill on top.
    const body = this.scratch('A', wd, hd);
    const bc = body.ctx;
    bc.setTransform(rs, 0, 0, rs, 0, 0);
    bc.font = font;
    bc.textAlign = 'left';
    bc.textBaseline = 'alphabetic';
    bc.lineJoin = 'round';
    bc.lineCap = 'round';
    bc.miterLimit = 2;
    bc.lineWidth = lw;
    bc.strokeStyle = rim;
    bc.fillStyle = rim;
    bc.strokeText(text, x0, y0 + ext);
    bc.fillText(text, x0, y0 + ext);
    bc.strokeStyle = outline;
    bc.strokeText(text, x0, y0);
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.drawImage(fill.canvas, 0, 0, wd, hd, 0, 0, wd, hd);

    const canvas = this.composeWithShadow(body.canvas, wd, hd, blur * rs, offY * rs, dark ? 'rgba(0, 0, 0, 0.42)' : toRgba(deep, 0.32));
    return {
      canvas,
      w: wd / rs,
      h: hd / rs,
      ax,
      ay,
      size: px,
      radius: Math.max(gw, gh) / 2 + lw / 2,
      halfW: inkW / 2,
      // The rim makes the bottom the far edge; captions hang below this.
      halfH: gh / 2 + lw / 2 + ext,
    };
  }

  private renderCaption(text: string, hex: string, px: number): Sprite {
    const font = `700 ${px}px ${this.fontFamily}`;
    const lw = px * 0.32;
    const blur = px * 0.08;
    const offY = px * 0.07;
    const probe = this.scratch('A', 4, 4);
    probe.ctx.font = font;
    const m = measure(probe.ctx, text, px, 0.72);
    const inkW = m.left + m.right + lw;
    const inkH = m.ascent + m.descent + lw;
    const pad = blur * 2 + offY + 3;
    const W = inkW + pad * 2;
    const H = inkH + pad * 2;
    const rs = Math.min(this.dpr, MAX_SPRITE_DEVICE_PX / Math.max(W, H));
    const wd = Math.ceil(W * rs);
    const hd = Math.ceil(H * rs);
    const ax = W / 2;
    const ay = pad + inkH / 2;
    const x0 = ax - (m.right - m.left) / 2;
    const y0 = pad + lw / 2 + m.ascent;

    const deep = deepShade(hex);
    const body = this.scratch('A', wd, hd);
    const bc = body.ctx;
    bc.setTransform(rs, 0, 0, rs, 0, 0);
    bc.font = font;
    bc.textAlign = 'left';
    bc.textBaseline = 'alphabetic';
    bc.lineJoin = 'round';
    bc.lineWidth = lw;
    bc.strokeStyle = deep;
    bc.strokeText(text, x0, y0);
    bc.fillStyle = '#ffffff';
    bc.fillText(text, x0, y0);
    const canvas = this.composeWithShadow(body.canvas, wd, hd, blur * rs, offY * rs, toRgba(deep, 0.35));
    return { canvas, w: wd / rs, h: hd / rs, ax, ay, size: px, radius: Math.max(inkW, inkH) / 2, halfW: inkW / 2, halfH: inkH / 2 };
  }

  // -- emoji ----------------------------------------------------------------

  /** Emoji as a sticker: white rim + soft shadow. `px` is the font size. */
  emoji(ch: string, px: number): Sprite {
    const bucket = sizeBucketIndex(px);
    const key = `${ch}|${bucket}|${this.dpr}`;
    const hit = this.emojis.get(key);
    if (hit) return hit;
    const size = sizeBucketPx(bucket);
    const sprite = this.safely(size, () => this.renderEmoji(ch, size));
    this.emojis.set(key, sprite, sprite.canvas.width * sprite.canvas.height * 4);
    return sprite;
  }

  private renderEmoji(ch: string, px: number): Sprite {
    const font = `${px}px ${EMOJI_FONT}`;
    const border = px * 0.075;
    const blur = px * 0.05;
    const offY = px * 0.05;

    const probe = this.scratch('A', 4, 4);
    probe.ctx.font = font;
    const m = measure(probe.ctx, ch, px, 0.86);
    const inkW = Math.max(m.left + m.right, px * 0.5);
    const inkH = Math.max(m.ascent + m.descent, px * 0.5);
    const pad = border + blur * 2 + offY + 3;
    const W = inkW + pad * 2;
    const H = inkH + pad * 2;
    const rs = Math.min(this.dpr, MAX_SPRITE_DEVICE_PX / Math.max(W, H));
    const wd = Math.ceil(W * rs);
    const hd = Math.ceil(H * rs);
    const ax = W / 2;
    const ay = pad + inkH / 2;
    const x0 = ax - (m.right - m.left) / 2;
    const y0 = pad + m.ascent;

    const art = this.scratch('A', wd, hd);
    const ac = art.ctx;
    ac.setTransform(rs, 0, 0, rs, 0, 0);
    ac.font = font;
    ac.textAlign = 'left';
    ac.textBaseline = 'alphabetic';
    ac.fillStyle = '#000000';
    ac.fillText(ch, x0, y0);

    // Sticker rim: dilate the silhouette by stamping it in a circle, then
    // recolour it white with source-in.
    const rim = this.scratch('B', wd, hd);
    const rc = rim.ctx;
    rc.setTransform(1, 0, 0, 1, 0, 0);
    const bd = border * rs;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      rc.drawImage(art.canvas, 0, 0, wd, hd, Math.cos(a) * bd, Math.sin(a) * bd, wd, hd);
    }
    rc.globalCompositeOperation = 'source-in';
    rc.fillStyle = 'rgba(255, 255, 255, 0.96)';
    rc.fillRect(0, 0, wd, hd);
    rc.globalCompositeOperation = 'source-over';
    rc.drawImage(art.canvas, 0, 0, wd, hd, 0, 0, wd, hd);

    const canvas = this.composeWithShadow(rim.canvas, wd, hd, blur * rs, offY * rs, 'rgba(20, 10, 40, 0.3)');
    return {
      canvas,
      w: wd / rs,
      h: hd / rs,
      ax,
      ay,
      size: px,
      radius: Math.max(inkW, inkH) / 2 + border,
      halfW: inkW / 2 + border,
      halfH: inkH / 2 + border,
    };
  }

  // -- shapes ---------------------------------------------------------------

  /** Shape body (no face) with a soft shadow. `r` is the shape radius in CSS px. */
  shape(shape: ShapeKind, color: NamedColor, r: number, dark: boolean): Sprite {
    const bucket = sizeBucketIndex(r);
    const key = `${shape}|${color.hex}|${bucket}|${this.dpr}|${dark ? 1 : 0}`;
    const hit = this.shapes.get(key);
    if (hit) return hit;
    const size = sizeBucketPx(bucket);
    const sprite = this.safely(size, () => this.renderShape(shape, color, size, dark));
    this.shapes.set(key, sprite, sprite.canvas.width * sprite.canvas.height * 4);
    return sprite;
  }

  private renderShape(shape: ShapeKind, color: NamedColor, r: number, dark: boolean): Sprite {
    const blur = r * 0.08;
    const offY = r * 0.08;
    const pad = r * 0.06 + blur * 1.5 + offY + 2; // outline stroke + shadow
    const W = r * 2 + pad * 2;
    const rs = Math.min(this.dpr, MAX_SPRITE_DEVICE_PX / W);
    const d = Math.ceil(W * rs);
    const body = this.scratch('A', d, d);
    const bc = body.ctx;
    bc.save();
    bc.setTransform(rs, 0, 0, rs, (W / 2) * rs, (W / 2) * rs);
    this.paintShape(bc, shape, r, color, dark);
    bc.restore();
    const canvas = this.composeWithShadow(body.canvas, d, d, blur * rs, offY * rs, dark ? 'rgba(0, 0, 0, 0.4)' : toRgba(deepShade(color.hex), 0.3));
    return {
      canvas,
      w: d / rs,
      h: d / rs,
      ax: W / 2,
      ay: W / 2,
      size: r,
      radius: r,
      halfW: r * 1.05,
      halfH: r * 1.05,
    };
  }

  // -- particles & effects ---------------------------------------------------

  /** Small sprite for a particle/effect kind in a colour (lazily created, never evicted). */
  particle(kind: number, colorId: number): HTMLCanvasElement {
    const slot = kind * this.colors.capacity + colorId;
    const cached = this.particles[slot];
    if (cached) return cached;
    let sprite: HTMLCanvasElement;
    try {
      sprite = this.renderParticle(kind, this.colors.hex(colorId));
    } catch {
      sprite = this.blank(); // out of canvas memory: draw nothing rather than crash
    }
    this.particles[slot] = sprite;
    return sprite;
  }

  private renderParticle(kind: number, hex: string): HTMLCanvasElement {
    if (kind === SPR_TAIL) return this.renderTail(hex);
    const P = kind === SPR_GLOW ? 64 : 48;
    const canvas = createCanvas(P, P);
    const ctx = get2d(canvas);
    const h = P / 2;
    ctx.translate(h, h);
    switch (kind) {
      case SPR_GLOW: {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, h);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.14, toRgba(lighten(hex, 0.55), 1));
        g.addColorStop(0.34, toRgba(hex, 0.6));
        g.addColorStop(0.66, toRgba(hex, 0.16));
        g.addColorStop(1, toRgba(hex, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-h, -h, P, P);
        break;
      }
      case SPR_BUBBLE: {
        const R = P * 0.42;
        const g = ctx.createRadialGradient(-R * 0.2, -R * 0.2, R * 0.1, 0, 0, R);
        g.addColorStop(0, toRgba(lighten(hex, 0.7), 0.06));
        g.addColorStop(0.8, toRgba(hex, 0.16));
        g.addColorStop(1, toRgba(hex, 0.32));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = P * 0.055;
        ctx.strokeStyle = toRgba(lighten(hex, 0.45), 0.92);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.ellipse(-R * 0.38, -R * 0.4, R * 0.24, R * 0.13, -0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(R * 0.42, R * 0.36, R * 0.07, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case SPR_PETAL: {
        const g = ctx.createLinearGradient(-h, 0, h, 0);
        g.addColorStop(0, lighten(hex, 0.55));
        g.addColorStop(0.6, hex);
        g.addColorStop(1, darken(hex, 0.08));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-P * 0.44, 0);
        ctx.bezierCurveTo(-P * 0.2, -P * 0.3, P * 0.3, -P * 0.26, P * 0.44, 0);
        ctx.bezierCurveTo(P * 0.3, P * 0.26, -P * 0.2, P * 0.3, -P * 0.44, 0);
        ctx.fill();
        ctx.strokeStyle = toRgba(lighten(hex, 0.6), 0.55);
        ctx.lineWidth = P * 0.03;
        ctx.beginPath();
        ctx.moveTo(-P * 0.34, 0);
        ctx.quadraticCurveTo(0, -P * 0.03, P * 0.3, 0);
        ctx.stroke();
        break;
      }
      case SPR_CONFETTI: {
        const w = P * 0.8;
        const ht = P * 0.46;
        ctx.fillStyle = hex;
        roundRect(ctx, -w / 2, -ht / 2, w, ht, ht * 0.25);
        ctx.fill();
        ctx.fillStyle = toRgba(lighten(hex, 0.5), 0.6);
        roundRect(ctx, -w / 2 + ht * 0.15, -ht / 2 + ht * 0.12, w - ht * 0.3, ht * 0.28, ht * 0.14);
        ctx.fill();
        break;
      }
      case SPR_STAR: {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, h);
        g.addColorStop(0, toRgba(lighten(hex, 0.6), 0.5));
        g.addColorStop(1, toRgba(hex, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-h, -h, P, P);
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 === 0 ? P * 0.36 : P * 0.16;
          if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.lineWidth = P * 0.06;
        ctx.strokeStyle = lighten(hex, 0.35);
        ctx.fillStyle = lighten(hex, 0.35);
        ctx.stroke();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath();
        ctx.arc(0, 0, P * 0.07, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case SPR_LEAF: {
        const g = ctx.createLinearGradient(0, -h, 0, h);
        g.addColorStop(0, lighten(hex, 0.25));
        g.addColorStop(1, darken(hex, 0.18));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-P * 0.44, 0);
        ctx.quadraticCurveTo(-P * 0.05, -P * 0.42, P * 0.44, 0);
        ctx.quadraticCurveTo(-P * 0.05, P * 0.42, -P * 0.44, 0);
        ctx.fill();
        ctx.strokeStyle = toRgba(lighten(hex, 0.55), 0.7);
        ctx.lineWidth = P * 0.035;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-P * 0.4, 0);
        ctx.lineTo(P * 0.36, 0);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
    return canvas;
  }

  /** Comet tail: a soft tapered streak, head at the right edge (256×64 device px). */
  private renderTail(hex: string): HTMLCanvasElement {
    const W = 256;
    const H = 64;
    const shapeCanvas = createCanvas(W, H);
    const sc = get2d(shapeCanvas);
    const path = (ctx: CanvasRenderingContext2D, thick: number) => {
      const r = (H / 2) * thick;
      ctx.beginPath();
      ctx.moveTo(4, H / 2);
      ctx.quadraticCurveTo(W * 0.55, H / 2 - r * 0.7, W - H / 2, H / 2 - r);
      ctx.arc(W - H / 2, H / 2, r, -Math.PI / 2, Math.PI / 2);
      ctx.quadraticCurveTo(W * 0.55, H / 2 + r * 0.7, 4, H / 2);
      ctx.closePath();
    };
    const g = sc.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, toRgba(hex, 0));
    g.addColorStop(0.55, toRgba(hex, 0.45));
    g.addColorStop(1, toRgba(hex, 1));
    sc.fillStyle = g;
    path(sc, 0.62);
    sc.fill();

    // Blurred copy via the off-canvas shadow trick (works without ctx.filter).
    const canvas = createCanvas(W, H);
    const ctx = get2d(canvas);
    ctx.shadowColor = toRgba(hex, 1);
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = W * 2;
    ctx.drawImage(shapeCanvas, -W * 2, 0);
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    // Bright core on top.
    const core = ctx.createLinearGradient(0, 0, W, 0);
    core.addColorStop(0, toRgba(lighten(hex, 0.6), 0));
    core.addColorStop(0.7, toRgba(lighten(hex, 0.6), 0.55));
    core.addColorStop(1, 'rgba(255,255,255,0.95)');
    ctx.fillStyle = core;
    path(ctx, 0.26);
    ctx.fill();
    return canvas;
  }

  // -- helpers ----------------------------------------------------------------

  /**
   * Runs a sprite render. If the browser refuses another canvas (iOS caps
   * total canvas memory), frees the caches and retries once, then falls back
   * to an invisible sprite: a missing letter beats an exception mid-play.
   */
  private safely(size: number, render: () => Sprite): Sprite {
    try {
      return render();
    } catch (err) {
      // Surface real bugs while developing; in production keep playing.
      if (!(err instanceof CanvasUnavailable) && import.meta.env?.DEV) throw err;
    }
    this.releaseCaches();
    try {
      return render();
    } catch {
      return { canvas: this.blank(), w: 1, h: 1, ax: 0.5, ay: 0.5, size, radius: size / 2, halfW: size / 2, halfH: size / 2 };
    }
  }

  private blank(): HTMLCanvasElement {
    if (!this.blankCanvas) this.blankCanvas = createCanvas(1, 1);
    return this.blankCanvas;
  }

  /** Copies `src` into a fresh canvas with a soft drop shadow (shadow drawn once, here). */
  private composeWithShadow(src: HTMLCanvasElement, wd: number, hd: number, blur: number, offY: number, color: string): HTMLCanvasElement {
    const canvas = createCanvas(wd, hd);
    const ctx = get2d(canvas);
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offY;
    ctx.drawImage(src, 0, 0, wd, hd, 0, 0, wd, hd);
    return canvas;
  }

  /** Shared scratch canvases (grow-only), cleared and reset for each use. */
  private scratch(which: 'A' | 'B', w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    let canvas = which === 'A' ? this.scratchA : this.scratchB;
    if (!canvas) {
      canvas = createCanvas(w, h);
      if (which === 'A') this.scratchA = canvas;
      else this.scratchB = canvas;
    } else if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    const ctx = get2d(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, Math.max(w, 4), Math.max(h, 4));
    return { canvas, ctx };
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
