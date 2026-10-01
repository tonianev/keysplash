/**
 * Flat, matte shape art (v2, DESIGN.md §2): flat fills, a soft tonal rim,
 * optional simple faces, and rounded arrows for direction cards.
 *
 * Every path is centred on (0, 0) and fits inside a circle of radius `r`; the
 * caller translates / rotates / scales. Geometry that needs trigonometry
 * (moon, heart) is solved once at module load in unit space, so tracing a
 * shape is only a handful of path commands and no allocations. No gradients,
 * no gloss, no glow.
 */
import type { DirectionName, NamedColor, ShapeKind } from '../types';
import { darken, lighten } from './color';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Precomputed unit geometry (r = 1)
// ---------------------------------------------------------------------------

/** Scratch vertex buffer (x, y pairs) for rounded polygons: up to 10 vertices. */
const VERTS = new Float64Array(20);

/**
 * Heart outline as cubic Béziers: a start point followed by 6 × (c1, c2, end).
 * Authored in a 0..1 box, then centred and scaled to fit the unit circle.
 */
const HEART = (() => {
  const raw = [
    0.5, 0.9,
    0.44, 0.86, 0.05, 0.62, 0.05, 0.33,
    0.05, 0.15, 0.18, 0.05, 0.3, 0.05,
    0.4, 0.05, 0.47, 0.11, 0.5, 0.2,
    0.53, 0.11, 0.6, 0.05, 0.7, 0.05,
    0.82, 0.05, 0.95, 0.15, 0.95, 0.33,
    0.95, 0.62, 0.56, 0.86, 0.5, 0.9,
  ];
  const out = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i += 2) {
    out[i] = (raw[i] - 0.5) * 1.8;
    out[i + 1] = (raw[i + 1] - 0.47) * 1.8;
  }
  return out;
})();

/** Crescent: an outer disc with an offset disc carved out, tilted like 🌙. */
const MOON = (() => {
  const R = 0.9; // outer disc
  const off = 0.5 * R; // carved disc offset along +x
  const ri = 0.8 * R; // carved disc radius
  const shift = 0.1 * R; // nudge right so the crescent's mass sits centred
  const tilt = -0.35; // horns point up-right
  // Intersection of the two circles (symmetric about the x axis before tilt).
  const a = (R * R - ri * ri + off * off) / (2 * off);
  const hgt = Math.sqrt(R * R - a * a);
  const outerTop = Math.atan2(-hgt, a);
  const innerTop = Math.atan2(-hgt, a - off);
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const faceX = (-R + (off - ri)) / 2 + shift; // middle of the thick band
  return {
    R,
    ri,
    ox: shift * cos,
    oy: shift * sin,
    ix: (shift + off) * cos,
    iy: (shift + off) * sin,
    outerStart: outerTop + tilt,
    outerEnd: -outerTop + tilt,
    innerStart: -innerTop + tilt,
    innerEnd: innerTop + tilt,
    faceX: faceX * cos,
    faceY: faceX * sin,
  };
})();

// ---------------------------------------------------------------------------
// Path tracing
// ---------------------------------------------------------------------------

/** Fills VERTS with a regular polygon (or a star when `inner` > 0); returns the vertex count. */
function regularVerts(n: number, radius: number, rot: number, inner: number): number {
  const total = inner > 0 ? n * 2 : n;
  for (let i = 0; i < total; i++) {
    const a = rot + (i * TAU) / total;
    const rr = inner > 0 && (i & 1) === 1 ? inner : radius;
    VERTS[i * 2] = Math.cos(a) * rr;
    VERTS[i * 2 + 1] = Math.sin(a) * rr;
  }
  return total;
}

/** Closed polygon through VERTS with every corner rounded (odd vertices may use another radius). */
function traceRoundedVerts(ctx: CanvasRenderingContext2D, total: number, cornerEven: number, cornerOdd: number): void {
  const lx = VERTS[total * 2 - 2];
  const ly = VERTS[total * 2 - 1];
  ctx.moveTo((lx + VERTS[0]) * 0.5, (ly + VERTS[1]) * 0.5);
  for (let i = 0; i < total; i++) {
    const j = i + 1 === total ? 0 : i + 1;
    const x = VERTS[i * 2];
    const y = VERTS[i * 2 + 1];
    ctx.arcTo(x, y, (x + VERTS[j * 2]) * 0.5, (y + VERTS[j * 2 + 1]) * 0.5, (i & 1) === 1 ? cornerOdd : cornerEven);
  }
  ctx.closePath();
}

function traceHeart(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.moveTo(HEART[0] * r, HEART[1] * r);
  for (let i = 2; i < HEART.length; i += 6) {
    ctx.bezierCurveTo(
      HEART[i] * r, HEART[i + 1] * r,
      HEART[i + 2] * r, HEART[i + 3] * r,
      HEART[i + 4] * r, HEART[i + 5] * r,
    );
  }
  ctx.closePath();
}

function traceMoon(ctx: CanvasRenderingContext2D, r: number): void {
  const m = MOON;
  ctx.arc(m.ox * r, m.oy * r, m.R * r, m.outerStart, m.outerEnd, true);
  ctx.arc(m.ix * r, m.iy * r, m.ri * r, m.innerStart, m.innerEnd, false);
  ctx.closePath();
}

/** Builds the outline path for `shape` (beginPath included; no fill or stroke). */
export function traceShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number): void {
  ctx.beginPath();
  if (!(r > 0)) return;
  switch (shape) {
    case 'square':
      traceRoundedVerts(ctx, regularVerts(4, r * 1.03, Math.PI / 4, 0), r * 0.22, r * 0.22);
      break;
    case 'triangle':
      traceRoundedVerts(ctx, regularVerts(3, r * 1.12, -Math.PI / 2, 0), r * 0.2, r * 0.2);
      break;
    case 'star':
      traceRoundedVerts(ctx, regularVerts(5, r * 1.1, -Math.PI / 2, r * 0.57), r * 0.15, r * 0.08);
      break;
    case 'heart':
      traceHeart(ctx, r);
      break;
    case 'diamond':
      VERTS[0] = 0; VERTS[1] = -r * 1.04;
      VERTS[2] = r * 0.75; VERTS[3] = 0;
      VERTS[4] = 0; VERTS[5] = r * 1.04;
      VERTS[6] = -r * 0.75; VERTS[7] = 0;
      traceRoundedVerts(ctx, 4, r * 0.16, r * 0.16);
      break;
    case 'moon':
      traceMoon(ctx, r);
      break;
    case 'oval':
      ctx.ellipse(0, 0, r * 0.98, r * 0.7, 0, 0, TAU);
      break;
    case 'rectangle':
      VERTS[0] = -r; VERTS[1] = -r * 0.62;
      VERTS[2] = r; VERTS[3] = -r * 0.62;
      VERTS[4] = r; VERTS[5] = r * 0.62;
      VERTS[6] = -r; VERTS[7] = r * 0.62;
      traceRoundedVerts(ctx, 4, r * 0.16, r * 0.16);
      break;
    case 'hexagon':
      traceRoundedVerts(ctx, regularVerts(6, r * 0.98, 0, 0), r * 0.2, r * 0.2);
      break;
    default: // 'circle', and any unknown kind degrades to a circle
      ctx.arc(0, 0, r * 0.94, 0, TAU);
  }
}


// ---------------------------------------------------------------------------
// Matte paint
// ---------------------------------------------------------------------------

/** Rim colours per (hex, dark) — tiny bounded cache so drawing never re-derives colours. */
const rimCache = new Map<string, string>();
const RIM_CACHE_MAX = 64;

function rimFor(hex: string, dark: boolean): string {
  const key = dark ? `d${hex}` : `l${hex}`;
  let rim = rimCache.get(key);
  if (!rim) {
    rim = dark ? lighten(hex, 0.14) : darken(hex, 0.16);
    if (rimCache.size >= RIM_CACHE_MAX) rimCache.clear();
    rimCache.set(key, rim);
  }
  return rim;
}

function rimWidth(r: number): number {
  return Math.max(1, Math.min(4, r * 0.04));
}

/** Flat matte fill in the colour itself, with a soft tonal rim. No gradients, no gloss. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number, color: NamedColor, dark: boolean): void {
  if (!(r > 0)) return;
  traceShape(ctx, shape, r);
  ctx.fillStyle = color.hex;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = rimWidth(r);
  ctx.strokeStyle = rimFor(color.hex, dark);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Faces (only when the grown-ups turn them on)
// ---------------------------------------------------------------------------

const FACE_INK = 'rgba(31,35,40,0.82)';

function faceCentre(shape: ShapeKind, r: number): [number, number] {
  switch (shape) {
    case 'triangle':
      return [0, r * 0.2];
    case 'moon':
      return [MOON.faceX * r, MOON.faceY * r];
    case 'heart':
      return [0, -r * 0.02];
    case 'star':
      return [0, r * 0.04];
    default:
      return [0, 0];
  }
}

/** A simple, friendly face. `blink` 0 open … 1 closed; 'oh' gives a small round mouth. */
export function drawFace(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number, blink: number, mood: 'smile' | 'oh'): void {
  if (!(r > 0)) return;
  const scale = shape === 'moon' ? 0.55 : shape === 'triangle' || shape === 'star' ? 0.8 : 1;
  const [cx, cy] = faceCentre(shape, r);
  const s = r * scale;
  const ex = s * 0.22;
  const ey = cy - s * 0.1;
  const er = Math.max(1, s * 0.075);
  ctx.fillStyle = FACE_INK;
  ctx.strokeStyle = FACE_INK;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, s * 0.05);
  const b = Math.min(1, Math.max(0, blink));
  for (const side of [-1, 1]) {
    const x = cx + side * ex;
    ctx.beginPath();
    if (b > 0.8) {
      // Closed: a gentle happy arc.
      ctx.arc(x, ey - er * 0.2, er, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else {
      ctx.ellipse(x, ey, er, er * (1 - b), 0, 0, TAU);
      ctx.fill();
    }
  }
  ctx.beginPath();
  if (mood === 'oh') {
    ctx.arc(cx, cy + s * 0.14, Math.max(1, s * 0.06), 0, TAU);
    ctx.fill();
  } else {
    ctx.arc(cx, cy + s * 0.04, s * 0.15, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Arrows (direction cards)
// ---------------------------------------------------------------------------

const ARROW_ANGLE: Record<DirectionName, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

/** Chunky rounded arrow outline pointing in `direction` (beginPath included). */
export function traceArrow(ctx: CanvasRenderingContext2D, direction: DirectionName, r: number): void {
  ctx.beginPath();
  if (!(r > 0)) return;
  const a = ARROW_ANGLE[direction] ?? 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Pointing right in unit space: shaft then head.
  const pts = [
    -0.85, -0.24, 0.05, -0.24, 0.05, -0.66, 0.9, 0, 0.05, 0.66, 0.05, 0.24, -0.85, 0.24,
  ];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] * r;
    const y = pts[i + 1] * r;
    VERTS[i] = x * cos - y * sin;
    VERTS[i + 1] = x * sin + y * cos;
  }
  traceRoundedVerts(ctx, pts.length / 2, r * 0.09, r * 0.09);
}

/** Flat matte arrow with the same rim treatment as shapes. */
export function drawArrow(ctx: CanvasRenderingContext2D, direction: DirectionName, r: number, color: NamedColor, dark: boolean): void {
  if (!(r > 0)) return;
  traceArrow(ctx, direction, r);
  ctx.fillStyle = color.hex;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = rimWidth(r);
  ctx.strokeStyle = rimFor(color.hex, dark);
  ctx.stroke();
}
