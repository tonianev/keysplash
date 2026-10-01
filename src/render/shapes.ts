/**
 * Cute shape art: outlines, glossy fills and kawaii faces.
 *
 * Every path is centred on (0, 0) and fits inside a circle of radius `r`; the
 * caller translates / rotates / scales. Geometry that needs trigonometry
 * (moon, flower, cloud, heart) is solved once at module load in unit space, so
 * tracing a shape per frame is only a handful of path commands and no
 * allocations. Fills are gradients built in unit space and cached per context
 * and colour, so drawing a shape every frame does not create new gradients.
 */
import type { NamedColor, ShapeKind } from '../types';

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

/** Five round petals; the outline is the outer arc of each petal circle. */
const FLOWER = (() => {
  const n = 5;
  const d = 0.53; // petal centre distance
  const pr = 0.42; // petal radius
  const half = Math.PI / n;
  // Outer intersection of neighbouring petals lies on their bisector.
  const q = d * Math.cos(half) + Math.sqrt(pr * pr - (d * Math.sin(half)) ** 2);
  const beta = Math.atan2(q * Math.sin(half), q * Math.cos(half) - d);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * TAU) / n;
    cx[i] = Math.cos(a) * d;
    cy[i] = Math.sin(a) * d;
    ang[i] = a;
  }
  return { n, pr, beta, cx, cy, ang, centre: 0.34 };
})();

function upperIntersection(
  x0: number, y0: number, r0: number,
  x1: number, y1: number, r1: number,
): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
  const px = x0 + (a * dx) / d;
  const py = y0 + (a * dy) / d;
  const ux = (h * dy) / d;
  const uy = (h * dx) / d;
  return py - uy < py + uy ? [px + ux, py - uy] : [px - ux, py + uy];
}

/**
 * Puffy cloud: a chain of four overlapping bumps traced along their outer
 * arcs, closed by a gently bulging flat bottom. Stored as 4 × (x, y, r, a0, a1).
 */
const CLOUD = (() => {
  const s = 0.95;
  const bumps = [
    [-0.6, 0.24, 0.32],
    [-0.25, -0.04, 0.4],
    [0.22, -0.14, 0.42],
    [0.6, 0.22, 0.34],
  ].map(([x, y, r]) => [x * s, y * s, r * s]);
  const meet: Array<[number, number]> = [];
  for (let i = 0; i < bumps.length - 1; i++) {
    const [x0, y0, r0] = bumps[i];
    const [x1, y1, r1] = bumps[i + 1];
    meet.push(upperIntersection(x0, y0, r0, x1, y1, r1));
  }
  const arcs = new Float64Array(bumps.length * 5);
  for (let i = 0; i < bumps.length; i++) {
    const [x, y, r] = bumps[i];
    const start = i === 0 ? Math.PI / 2 : Math.atan2(meet[i - 1][1] - y, meet[i - 1][0] - x);
    const end = i === bumps.length - 1 ? Math.PI / 2 : Math.atan2(meet[i][1] - y, meet[i][0] - x);
    arcs.set([x, y, r, start, end], i * 5);
  }
  const [fx, fy, fr] = bumps[0];
  return { arcs, count: bumps.length, startX: fx, startY: fy + fr, bulgeY: (fy + fr) * 1.14 };
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

function traceFlower(ctx: CanvasRenderingContext2D, r: number): void {
  const f = FLOWER;
  for (let i = 0; i < f.n; i++) {
    ctx.arc(f.cx[i] * r, f.cy[i] * r, f.pr * r, f.ang[i] - f.beta, f.ang[i] + f.beta, false);
  }
  ctx.closePath();
}

function traceCloud(ctx: CanvasRenderingContext2D, r: number): void {
  const a = CLOUD.arcs;
  for (let i = 0; i < CLOUD.count; i++) {
    const o = i * 5;
    ctx.arc(a[o] * r, a[o + 1] * r, a[o + 2] * r, a[o + 3], a[o + 4], false);
  }
  ctx.quadraticCurveTo(0, CLOUD.bulgeY * r, CLOUD.startX * r, CLOUD.startY * r);
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
    case 'flower':
      traceFlower(ctx, r);
      break;
    case 'hexagon':
      traceRoundedVerts(ctx, regularVerts(6, r * 0.98, 0, 0), r * 0.2, r * 0.2);
      break;
    case 'cloud':
      traceCloud(ctx, r);
      break;
    default: // 'circle', and any unknown kind degrades to a circle
      ctx.arc(0, 0, r * 0.94, 0, TAU);
  }
}

// ---------------------------------------------------------------------------
// Colour + cached paints
// ---------------------------------------------------------------------------

interface Rgb { r: number; g: number; b: number }

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function parseHex(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || Number.isNaN(n)) return { r: 160, g: 160, b: 170 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function css(c: Rgb): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

interface Paint {
  /** Gradient in unit space: draw with the context scaled by r. */
  fill: CanvasGradient;
  stroke: string;
}

interface PaintSet {
  light: Map<string, Paint>;
  dark: Map<string, Paint>;
}

/** Gradients are per context; palettes are small, but cap anyway in case colours are generated. */
const paintCache = new WeakMap<CanvasRenderingContext2D, PaintSet>();
const PAINT_CACHE_MAX = 64;

function paintFor(ctx: CanvasRenderingContext2D, hex: string, dark: boolean): Paint {
  let set = paintCache.get(ctx);
  if (!set) {
    set = { light: new Map(), dark: new Map() };
    paintCache.set(ctx, set);
  }
  const map = dark ? set.dark : set.light;
  let paint = map.get(hex);
  if (!paint) {
    if (map.size >= PAINT_CACHE_MAX) map.clear();
    const base = parseHex(hex);
    const fill = ctx.createLinearGradient(-0.75, -0.85, 0.65, 0.9);
    fill.addColorStop(0, css(mix(base, WHITE, 0.5)));
    fill.addColorStop(0.42, css(base));
    fill.addColorStop(1, css(mix(base, BLACK, 0.2)));
    paint = {
      fill,
      // Dark worlds: a soft, very light tint. Light worlds: a deep shade of the colour.
      stroke: dark ? css(mix(base, WHITE, 0.78)) : css(mix(base, BLACK, 0.45)),
    };
    map.set(hex, paint);
  }
  return paint;
}

// ---------------------------------------------------------------------------
// drawShape
// ---------------------------------------------------------------------------

/** Glossy highlight per shape: centre (x, y) and size, in unit space, placed on a broad top-left area. */
const GLOSS: Record<ShapeKind, readonly [number, number, number]> = {
  circle: [-0.38, -0.42, 1],
  square: [-0.38, -0.42, 1],
  triangle: [-0.22, -0.12, 0.7],
  star: [-0.17, -0.32, 0.6],
  heart: [-0.42, -0.4, 0.8],
  diamond: [-0.2, -0.38, 0.6],
  moon: [-0.58, -0.32, 0.55],
  flower: [-0.5, -0.26, 0.55],
  hexagon: [-0.36, -0.4, 0.95],
  cloud: [-0.33, -0.26, 0.8],
};

const GLOSS_SOFT = 'rgba(255,255,255,0.38)';
const GLOSS_HOT = 'rgba(255,255,255,0.75)';
const FLOWER_CENTRE = '#ffd84d';
const FLOWER_CENTRE_ALT = '#ff9f43'; // for yellow flowers

/** Clipped glossy highlight. Expects the shape path to be current and the context scaled by r. */
function drawGloss(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.clip();
  ctx.fillStyle = GLOSS_SOFT;
  ctx.beginPath();
  ctx.ellipse(x, y, 0.3 * s, 0.16 * s, -0.7, 0, TAU);
  ctx.fill();
  ctx.fillStyle = GLOSS_HOT;
  ctx.beginPath();
  ctx.ellipse(x - 0.06 * s, y - 0.02 * s, 0.09 * s, 0.05 * s, -0.7, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Gradient-filled shape (light top-left → colour → deeper bottom-right) with a
 * thick rounded outline and a glossy highlight. Centred on (0, 0).
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: ShapeKind,
  r: number,
  color: NamedColor,
  dark: boolean,
): void {
  if (!(r > 0)) return;
  const paint = paintFor(ctx, color.hex, dark);
  const g = GLOSS[shape] ?? GLOSS.circle;
  const lineWidth = Math.max(0.085, 1.5 / r); // ≥ 1.5 px at small sizes

  ctx.save();
  ctx.scale(r, r); // everything below is in unit space, so cached gradients fit any size
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  traceShape(ctx, shape, 1);
  ctx.fillStyle = paint.fill;
  ctx.fill();
  drawGloss(ctx, g[0], g[1], g[2]);

  traceShape(ctx, shape, 1); // the gloss replaced the path
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = paint.stroke;
  ctx.stroke();

  if (shape === 'flower') {
    const c = FLOWER.centre;
    const centre = paintFor(ctx, color.name === 'yellow' || color.name === 'orange' ? FLOWER_CENTRE_ALT : FLOWER_CENTRE, dark);
    ctx.beginPath();
    ctx.arc(0, 0, c, 0, TAU);
    ctx.fillStyle = centre.fill;
    ctx.fill();
    drawGloss(ctx, -0.12, -0.14, 0.42);
    ctx.beginPath();
    ctx.arc(0, 0, c, 0, TAU);
    ctx.lineWidth = lineWidth * 0.8;
    ctx.strokeStyle = centre.stroke;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// drawFace
// ---------------------------------------------------------------------------

/** Face placement per shape: centre (x, y) and scale, in units of r. */
const FACE: Record<ShapeKind, readonly [number, number, number]> = {
  circle: [0, 0.06, 0.95],
  square: [0, 0.06, 0.95],
  triangle: [0, 0.16, 0.68], // lower centre, where the triangle is wide
  star: [0, 0.06, 0.6],
  heart: [0, -0.02, 0.85],
  diamond: [0, 0.02, 0.68],
  moon: [MOON.faceX, MOON.faceY, 0.44], // on the thick inner band
  flower: [0, 0, 0.4], // on the centre disc
  hexagon: [0, 0.04, 0.92],
  cloud: [0, 0.14, 0.8],
};

const EYE = '#2b2140';
const GLINT = '#ffffff';
const CHEEK = 'rgba(255,110,150,0.42)';
const TONGUE = '#ff7a93';
// Face layout in face units (1 = the face's scaled radius).
const EYE_X = 0.3;
const EYE_Y = -0.06;
const EYE_RX = 0.1;
const EYE_RY = 0.13;
const LID_R = 0.085;
const LID_A0 = Math.PI * 1.1;
const LID_A1 = Math.PI * 1.9;
const LID_DX = Math.cos(LID_A0) * LID_R;
const LID_DY = Math.sin(LID_A0) * LID_R;

/**
 * Kawaii face: two dark eyes with glints (blink 0 open … 1 a happy closed
 * arc), rosy cheeks, and a small smile or an "oh" mouth.
 */
export function drawFace(
  ctx: CanvasRenderingContext2D,
  shape: ShapeKind,
  r: number,
  blink: number,
  mood: 'smile' | 'oh',
): void {
  if (!(r > 0)) return;
  const f = FACE[shape] ?? FACE.circle;
  const u = r * f[2];
  const b = blink > 0 ? (blink < 1 ? blink : 1) : 0; // also maps NaN to 0
  const lineWidth = Math.max(0.07, 1.2 / u);

  ctx.save();
  ctx.translate(f[0] * r, f[1] * r);
  ctx.scale(u, u);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Cheeks
  ctx.fillStyle = CHEEK;
  ctx.beginPath();
  ctx.ellipse(-0.52, 0.17, 0.14, 0.085, 0, 0, TAU);
  ctx.moveTo(0.66, 0.17);
  ctx.ellipse(0.52, 0.17, 0.14, 0.085, 0, 0, TAU);
  ctx.fill();

  // Eyes
  ctx.fillStyle = EYE;
  ctx.strokeStyle = EYE;
  if (b < 0.7) {
    const squash = 1 - b * 1.2; // 1 → 0.16 just before the closed arc
    const ry = EYE_RY * squash;
    ctx.beginPath();
    ctx.ellipse(-EYE_X, EYE_Y, EYE_RX, ry, 0, 0, TAU);
    ctx.moveTo(EYE_X + EYE_RX, EYE_Y);
    ctx.ellipse(EYE_X, EYE_Y, EYE_RX, ry, 0, 0, TAU);
    ctx.fill();
    if (squash > 0.5) {
      const gy = EYE_Y - 0.045 * squash;
      ctx.fillStyle = GLINT;
      ctx.beginPath();
      ctx.arc(-EYE_X - 0.03, gy, 0.036, 0, TAU);
      ctx.moveTo(EYE_X - 0.03 + 0.036, gy);
      ctx.arc(EYE_X - 0.03, gy, 0.036, 0, TAU);
      ctx.fill();
    }
  } else {
    // Happy closed eyes: ∩ ∩
    const y = EYE_Y + 0.04;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(-EYE_X, y, LID_R, LID_A0, LID_A1);
    ctx.moveTo(EYE_X + LID_DX, y + LID_DY);
    ctx.arc(EYE_X, y, LID_R, LID_A0, LID_A1);
    ctx.stroke();
  }

  // Mouth
  if (mood === 'oh') {
    ctx.fillStyle = EYE;
    ctx.beginPath();
    ctx.ellipse(0, 0.2, 0.07, 0.085, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = TONGUE;
    ctx.beginPath();
    ctx.ellipse(0, 0.245, 0.04, 0.025, 0, 0, TAU);
    ctx.fill();
  } else {
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(0, 0.07, 0.13, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
  }
  ctx.restore();
}
