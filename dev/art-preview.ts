/**
 * Dev-only art preview (served by `vite` at /dev/art-preview.html; not part of
 * the production build). Shows every backdrop as a live tile with its CPU cost,
 * and every shape in a world's palette with blinking faces, plus one big
 * shape at r = 300 to check detail.
 */
import { WORLDS, WORLD_ORDER } from '../src/worlds';
import { createBackdrop, type Backdrop } from '../src/render/backgrounds';
import { drawFace, drawShape } from '../src/render/shapes';
import type { ShapeKind, World, WorldId } from '../src/types';

const SHAPES: ShapeKind[] = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'moon', 'flower', 'hexagon', 'cloud'];
const BUDGET_MS = 1.5;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  return ctx;
}

const reduceMotionInput = $('reduce-motion') as HTMLInputElement;
const calmInput = $('calm') as HTMLInputElement;
const pausedInput = $('paused') as HTMLInputElement;
const facesInput = $('faces') as HTMLInputElement;
const worldSelect = $('world') as HTMLSelectElement;

let calm = 0;
calmInput.addEventListener('input', () => {
  calm = Number(calmInput.value);
  $('calm-value').textContent = calm.toFixed(2);
});

// ---------------------------------------------------------------------------
// Backdrop tiles
// ---------------------------------------------------------------------------

interface Tile {
  world: World;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cost: HTMLElement;
  backdrop: Backdrop;
  width: number;
  height: number;
  dpr: number;
  /** Smoothed update + draw time in ms. */
  ms: number;
}

const tiles: Tile[] = [];

function sizeTile(tile: Tile): void {
  const width = Math.max(1, tile.canvas.clientWidth);
  const height = Math.max(1, tile.canvas.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  tile.width = width;
  tile.height = height;
  tile.dpr = dpr;
  tile.canvas.width = Math.round(width * dpr);
  tile.canvas.height = Math.round(height * dpr);
  tile.backdrop.resize(width, height, dpr);
}

const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const tile = tiles.find((t) => t.canvas === entry.target);
    if (tile) sizeTile(tile);
  }
});

for (const id of WORLD_ORDER) {
  const world = WORLDS[id];
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas');
  const caption = document.createElement('figcaption');
  const name = document.createElement('span');
  name.innerHTML = `<b>${world.icon} ${world.label}</b> · ${world.background}`;
  const cost = document.createElement('span');
  cost.className = 'cost';
  caption.append(name, cost);
  figure.append(canvas, caption);
  figure.addEventListener('click', () => figure.classList.toggle('big'));
  $('tiles').append(figure);
  const tile: Tile = {
    world,
    canvas,
    ctx: context2d(canvas),
    cost,
    backdrop: createBackdrop(world, { reduceMotion: reduceMotionInput.checked }),
    width: 0,
    height: 0,
    dpr: 1,
    ms: 0,
  };
  tiles.push(tile);
  observer.observe(canvas);
}

reduceMotionInput.addEventListener('change', () => {
  for (const tile of tiles) {
    tile.backdrop = createBackdrop(tile.world, { reduceMotion: reduceMotionInput.checked });
    sizeTile(tile);
  }
});

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const CELL = 110;
const R = 42;
const gridCanvas = $('shape-grid') as HTMLCanvasElement;
const gridCtx = context2d(gridCanvas);
const bigCanvas = $('shape-big') as HTMLCanvasElement;
const bigCtx = context2d(bigCanvas);
const BIG = 640;

for (const id of WORLD_ORDER) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = `${WORLDS[id].icon} ${WORLDS[id].label}`;
  worldSelect.append(option);
}
worldSelect.value = 'garden';

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  return dpr;
}

/** Deterministic blink: a quick 0 → 1 → 0 every few seconds, offset per seed. */
function blinkAt(now: number, seed: number): number {
  const period = 2.5 + (seed % 5) * 0.6;
  const phase = (now / 1000 + seed * 1.37) % period;
  return phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) : 0;
}

function paintSky(ctx: CanvasRenderingContext2D, world: World, width: number, height: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, world.sky[0]);
  g.addColorStop(1, world.sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

function paintShape(ctx: CanvasRenderingContext2D, world: World, shape: ShapeKind, x: number, y: number, r: number, colorIndex: number, seed: number, now: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(now / 900 + seed) * 0.08);
  drawShape(ctx, shape, r, world.palette[colorIndex % world.palette.length], world.dark);
  if (facesInput.checked) {
    const mood = Math.floor(now / 4000 + seed * 0.37) % 3 === 0 ? 'oh' : 'smile';
    drawFace(ctx, shape, r, blinkAt(now, seed), mood);
  }
  ctx.restore();
}

let gridDpr = 1;
let gridHeight = 0;
const gridWidth = SHAPES.length * CELL;

function layoutShapes(): void {
  const world = WORLDS[worldSelect.value as WorldId];
  gridHeight = world.palette.length * CELL + CELL; // + a strip of small sizes
  gridDpr = sizeCanvas(gridCanvas, gridWidth, gridHeight);
  sizeCanvas(bigCanvas, BIG, BIG);
}
worldSelect.addEventListener('change', layoutShapes);
layoutShapes();

function drawShapes(now: number): void {
  const world = WORLDS[worldSelect.value as WorldId];
  gridCtx.setTransform(gridDpr, 0, 0, gridDpr, 0, 0);
  paintSky(gridCtx, world, gridWidth, gridHeight);
  world.palette.forEach((_, row) => {
    SHAPES.forEach((shape, col) => {
      paintShape(gridCtx, world, shape, col * CELL + CELL / 2, row * CELL + CELL / 2, R, row + col, row * 10 + col, now);
    });
  });
  // Size strip: r = 20 (the smallest the scene should use)
  SHAPES.forEach((shape, col) => {
    paintShape(gridCtx, world, shape, col * CELL + CELL / 2, gridHeight - CELL / 2, 20, col, 100 + col, now);
  });

  const bigDpr = bigCanvas.width / BIG;
  bigCtx.setTransform(bigDpr, 0, 0, bigDpr, 0, 0);
  paintSky(bigCtx, world, BIG, BIG);
  const step = Math.floor(now / 3000);
  paintShape(bigCtx, world, SHAPES[step % SHAPES.length], BIG / 2, BIG / 2, 300, step, 7, now);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

let last = performance.now();
let lastLabel = 0;

function frame(now: number): void {
  const dt = pausedInput.checked ? 0 : Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const tile of tiles) {
    if (tile.width === 0) continue;
    const t0 = performance.now();
    tile.backdrop.update(dt, now, calm);
    tile.ctx.setTransform(tile.dpr, 0, 0, tile.dpr, 0, 0);
    tile.backdrop.draw(tile.ctx);
    tile.ms = tile.ms * 0.95 + (performance.now() - t0) * 0.05;
  }
  if (now - lastLabel > 500) {
    lastLabel = now;
    for (const tile of tiles) {
      tile.cost.textContent = `${tile.ms.toFixed(2)} ms · ${tile.width}×${tile.height}@${tile.dpr}`;
      tile.cost.classList.toggle('over', tile.ms > BUDGET_MS);
    }
  }
  if (!pausedInput.checked) drawShapes(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
