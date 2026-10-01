/**
 * Flashcards (DESIGN.md §3): layout math and pre-rendered card sprites.
 *
 * A card is drawn ONCE into an offscreen canvas at device resolution — tinted
 * surface, baked soft elevation, glyph, picture and word — then blitted with a
 * transform every frame. Sprites carry generous transparent padding so the
 * baked shadow never touches the canvas edge (v1 drew faint lines there).
 * Counted pictures on digit cards are drawn live, so only their cell centres
 * are computed here.
 */
import type { CardSpec, Layout, SizeLevel, World } from '../types';
import { drawArrow, drawShape } from './shapes';

export const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// ---------------------------------------------------------------------------
// Layout (pure — unit tested)
// ---------------------------------------------------------------------------

const SIZE_FACTOR: Record<SizeLevel, number> = { normal: 0.82, big: 0.92, huge: 1 };

export interface Box {
  x: number; // centre
  y: number; // centre
  w: number;
  h: number;
}

/** Width/height ratio per card kind: digit cards are wider (numeral + ten-frame). */
export function cardAspect(kind: CardSpec['kind']): number {
  return kind === 'digit' ? 16 / 9 : 4 / 3;
}

/** Vertical band reserved for the centre card: below the prompt bar, above the shelf. */
export function centreBand(height: number): { top: number; bottom: number } {
  return { top: height * 0.13, bottom: height * 0.8 };
}

/** The centre card's box in focus layout. */
export function focusCardBox(kind: CardSpec['kind'], width: number, height: number, size: SizeLevel): Box {
  const aspect = cardAspect(kind);
  const band = centreBand(height);
  const availH = (band.bottom - band.top) * 0.96;
  const maxW = width * (kind === 'digit' ? 0.82 : 0.66);
  let w = Math.min(maxW, availH * aspect) * SIZE_FACTOR[size];
  w = Math.max(120, w);
  const h = w / aspect;
  return { x: width / 2, y: (band.top + band.bottom) / 2, w, h };
}

/** Shelf thumbnail height (focus layout). */
export function shelfHeight(height: number): number {
  return Math.min(130, Math.max(44, height * 0.11));
}

/**
 * Shelf slots for thumbnails of the given aspects, oldest left → newest right
 * (the shelf reads like what was typed). Returns centre boxes; the row is
 * centred and shrinks to fit the width if needed.
 */
export function shelfSlots(aspects: readonly number[], width: number, height: number): Box[] {
  if (aspects.length === 0) return [];
  let th = shelfHeight(height);
  let gap = th * 0.2;
  const total = (t: number, g: number): number => aspects.reduce((s, a) => s + a * t, 0) + g * (aspects.length - 1);
  const maxW = width * 0.92;
  const need = total(th, gap);
  if (need > maxW) {
    const k = maxW / need;
    th *= k;
    gap *= k;
  }
  const y = height - th / 2 - Math.max(10, height * 0.03);
  let x = (width - total(th, gap)) / 2;
  return aspects.map((a) => {
    const w = a * th;
    const box = { x: x + w / 2, y, w, h: th };
    x += w + gap;
    return box;
  });
}

/** Card box size in keyboard layout (smaller cards where the key is). */
export function keyboardCardSize(kind: CardSpec['kind'], width: number, height: number, size: SizeLevel): { w: number; h: number } {
  const f = focusCardBox(kind, width, height, size);
  return { w: f.w * 0.45, h: f.h * 0.45 };
}

/** Max simultaneous cards in keyboard layout, by intensity. */
export const KEYBOARD_CAP = { calm: 6, normal: 10, lively: 16 } as const;

/** Max shelf thumbnails in focus layout. */
export const SHELF_MAX = 6;

/** Which layout a card belongs to (helper for callers). */
export function isFocus(layout: Layout): boolean {
  return layout === 'focus';
}

/**
 * Ten-frame cells (2 rows × 5) for a digit card of size w×h, as centres
 * relative to the card centre, plus the cell size.
 */
export function tenFrame(w: number, h: number): { cells: Float32Array; cell: number } {
  const left = -w / 2 + w * 0.4;
  const right = w / 2 - w * 0.05;
  const top = -h / 2 + h * 0.13;
  const bottom = -h / 2 + h * 0.7;
  const cell = Math.min((right - left) / 5, (bottom - top) / 2);
  const ox = (left + right) / 2 - cell * 2.5;
  const oy = (top + bottom) / 2 - cell;
  const cells = new Float32Array(20);
  for (let i = 0; i < 10; i++) {
    cells[i * 2] = ox + (i % 5) * cell + cell / 2;
    cells[i * 2 + 1] = oy + Math.floor(i / 5) * cell + cell / 2;
  }
  return { cells, cell };
}

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

export interface CardSprite {
  canvas: HTMLCanvasElement;
  /** Transparent margin (CSS px) around the card on every side. */
  pad: number;
  w: number;
  h: number;
}

export interface CardStyle {
  world: World;
  fontFamily: string;
  dpr: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Cache key: everything that changes a card's pixels. */
export function cardKey(spec: CardSpec, w: number, h: number, style: CardStyle): string {
  return [
    spec.kind, spec.text ?? '', spec.picture ?? '', spec.word ?? '', spec.highlight?.join('-') ?? '',
    spec.shape ?? '', spec.direction ?? '', spec.color?.container ?? '', spec.color?.ink ?? '',
    style.world.id, Math.round(w), Math.round(h), style.dpr, style.fontFamily,
  ].join('|');
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws text centred on (cx, cy) using real glyph bounds, shrinking to fit maxW. */
function centredText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, px: number, maxW: number, font: string): void {
  let size = px;
  ctx.font = `700 ${size}px ${font}`;
  let m = ctx.measureText(text);
  if (m.width > maxW && m.width > 0) {
    size = Math.max(8, size * (maxW / m.width));
    ctx.font = `700 ${size}px ${font}`;
    m = ctx.measureText(text);
  }
  const ascent = m.actualBoundingBoxAscent ?? size * 0.7;
  const descent = m.actualBoundingBoxDescent ?? 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, cx, cy + (ascent - descent) / 2);
}

function emojiAt(ctx: CanvasRenderingContext2D, emoji: string, cx: number, cy: number, px: number): void {
  ctx.font = `${px}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(emoji, cx, cy);
}

/** The word line, with the [start, end) highlight in the card colour's ink. */
function wordLine(
  ctx: CanvasRenderingContext2D, word: string, highlight: [number, number] | null | undefined,
  cx: number, cy: number, px: number, maxW: number, font: string, neutral: string, ink: string,
): void {
  let size = px;
  ctx.font = `700 ${size}px ${font}`;
  let total = ctx.measureText(word).width;
  if (total > maxW && total > 0) {
    size = Math.max(8, size * (maxW / total));
    ctx.font = `700 ${size}px ${font}`;
    total = ctx.measureText(word).width;
  }
  const m = ctx.measureText(word);
  const ascent = m.actualBoundingBoxAscent ?? size * 0.7;
  const descent = m.actualBoundingBoxDescent ?? 0;
  const y = cy + (ascent - descent) / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const [a, b] = highlight ? [Math.max(0, highlight[0]), Math.min(word.length, highlight[1])] : [0, 0];
  const parts: Array<[string, string]> = [
    [word.slice(0, a), neutral],
    [word.slice(a, b), ink],
    [word.slice(b), neutral],
  ];
  let x = cx - total / 2;
  for (const [text, color] of parts) {
    if (!text) continue;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width;
  }
}

/**
 * Renders a card into a padded sprite at device resolution. Returns null when
 * no canvas is available (tests / no DOM).
 */
export function renderCard(spec: CardSpec, w: number, h: number, style: CardStyle): CardSprite | null {
  const { world, fontFamily: font, dpr } = style;
  const blur = w * 0.06;
  const pad = Math.ceil(blur + w * 0.03 + 8);
  const canvas = makeCanvas((w + pad * 2) * dpr, (h + pad * 2) * dpr);
  const ctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);

  const surface = spec.kind === 'picture' || !spec.color ? world.surface : spec.color.container;
  const ink = spec.color?.ink ?? world.onSurface;
  // The featured letter is drawn in ink; the rest of the word steps back so it stands out.
  const neutral = world.dark ? '#98A1B3' : '#5B616B';
  const radius = Math.min(w * 0.12, h * 0.18);

  // Baked elevation: a tight contact shadow and a soft ambient one.
  const shadows: Array<[number, number, string]> = world.dark
    ? [[w * 0.012 + 2, w * 0.004 + 1, 'rgba(0,0,0,0.35)'], [blur, w * 0.025, 'rgba(0,0,0,0.38)']]
    : [[w * 0.012 + 2, w * 0.004 + 1, 'rgba(20,24,32,0.08)'], [blur, w * 0.025, 'rgba(20,24,32,0.10)']];
  for (const [b, y, color] of shadows) {
    ctx.save();
    ctx.shadowBlur = b * dpr;
    ctx.shadowOffsetY = y * dpr;
    ctx.shadowColor = color;
    roundedRect(ctx, 0, 0, w, h, radius);
    ctx.fillStyle = surface;
    ctx.fill();
    ctx.restore();
  }
  roundedRect(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = surface;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = world.dark ? 'rgba(255,255,255,0.07)' : 'rgba(31,35,40,0.07)';
  ctx.stroke();

  const wordY = h * 0.83;
  const wordPx = h * 0.135;
  switch (spec.kind) {
    case 'letter': {
      const hasPicture = !!spec.picture;
      ctx.fillStyle = ink;
      centredText(ctx, spec.text ?? '', hasPicture ? w * 0.42 : w * 0.5, h * 0.42, h * 0.5, hasPicture ? w * 0.6 : w * 0.8, font);
      if (spec.picture) emojiAt(ctx, spec.picture, w * 0.79, h * 0.3, h * 0.28);
      break;
    }
    case 'digit': {
      ctx.fillStyle = ink;
      centredText(ctx, spec.text ?? '', w * 0.2, h * 0.42, h * 0.62, w * 0.3, font);
      const { cells, cell } = tenFrame(w, h);
      ctx.lineWidth = Math.max(1, cell * 0.03);
      ctx.strokeStyle = world.dark ? 'rgba(255,255,255,0.16)' : 'rgba(31,35,40,0.14)';
      for (let i = 0; i < 10; i++) {
        const cx = cells[i * 2] + w / 2;
        const cy = cells[i * 2 + 1] + h / 2;
        const s = cell * 0.88;
        roundedRect(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.2);
        ctx.stroke();
      }
      break;
    }
    case 'shape':
      if (spec.shape && spec.color) {
        ctx.save();
        ctx.translate(w / 2, h * 0.42);
        drawShape(ctx, spec.shape, h * 0.27, spec.color, world.dark);
        ctx.restore();
      }
      break;
    case 'direction':
      if (spec.direction && spec.color) {
        ctx.save();
        ctx.translate(w / 2, h * 0.42);
        drawArrow(ctx, spec.direction, h * 0.3, spec.color, world.dark);
        ctx.restore();
      }
      break;
    case 'picture':
      if (spec.picture) emojiAt(ctx, spec.picture, w / 2, h * 0.42, h * 0.44);
      break;
  }
  if (spec.word) wordLine(ctx, spec.word, spec.highlight, w / 2, wordY, wordPx, w * 0.86, font, neutral, ink);
  return { canvas, pad, w, h };
}

/** Bytes a sprite occupies (LRU cost). */
export function spriteCost(sprite: { canvas: HTMLCanvasElement }): number {
  return sprite.canvas.width * sprite.canvas.height * 4;
}

/**
 * Emoji drawn into small padded sprites (for counted pictures, tap pictures and
 * idle friends), so drawing them each frame is a single drawImage.
 */
export function renderEmoji(emoji: string, px: number, dpr: number): HTMLCanvasElement | null {
  const pad = Math.ceil(px * 0.25) + 2;
  const size = px + pad * 2;
  const canvas = makeCanvas(size * dpr, size * dpr);
  const ctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  emojiAt(ctx, emoji, size / 2, size / 2, px);
  return canvas;
}
