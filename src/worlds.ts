/**
 * The seven play worlds (v2: matte, tonal, calm — see DESIGN.md §2).
 *
 * Colour rule: every light world shares one tonal palette and every dark world
 * shares another, so "red" is always the same red. A child learning colour
 * names should never meet two different "yellows".
 *
 * Emoji rules: Unicode 13 or older, no ZWJ sequences, so everything renders on
 * 2020-era Macs, iPads and Chromebooks.
 */
import type { NamedColor, World, WorldId } from './types';

/** Light worlds: pale tinted cards, deep ink. Ink vs container ≥ 4.5:1 (tested). */
export const LIGHT_PALETTE: readonly NamedColor[] = Object.freeze([
  { name: 'red', hex: '#E0604F', container: '#FCE4E0', ink: '#A3291C' },
  { name: 'orange', hex: '#EE8A3C', container: '#FDE9D6', ink: '#9A4A0C' },
  { name: 'yellow', hex: '#E9B730', container: '#FBF0CC', ink: '#7A5800' },
  { name: 'green', hex: '#4FA66A', container: '#DDF1E2', ink: '#1F6B37' },
  { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' },
  { name: 'purple', hex: '#8B6CD1', container: '#ECE5FA', ink: '#56389A' },
  { name: 'pink', hex: '#DE6FA1', container: '#FBE3EE', ink: '#9C2D63' },
  { name: 'brown', hex: '#A07452', container: '#F1E6DC', ink: '#6A4527' },
] satisfies NamedColor[]);

/** Dark worlds: deep tinted cards, light ink. */
export const DARK_PALETTE: readonly NamedColor[] = Object.freeze([
  { name: 'red', hex: '#EE7B6B', container: '#4A2320', ink: '#FFD3CC' },
  { name: 'orange', hex: '#F39A55', container: '#4A2E17', ink: '#FFDDBF' },
  { name: 'yellow', hex: '#EFC453', container: '#463A12', ink: '#FBE7A6' },
  { name: 'green', hex: '#6CBF85', container: '#1E3D2A', ink: '#C5ECD1' },
  { name: 'blue', hex: '#6FA1E6', container: '#1C3253', ink: '#CFE0FB' },
  { name: 'purple', hex: '#A68CE0', container: '#33285A', ink: '#E3D9FB' },
  { name: 'pink', hex: '#E88AB5', container: '#4A2338', ink: '#FBD3E5' },
  { name: 'brown', hex: '#BC9172', container: '#3D2D22', ink: '#EED9C8' },
] satisfies NamedColor[]);

const LIGHT_SURFACE = { surface: '#FFFFFF', onSurface: '#1F2328' };
const DARK_SURFACE = { surface: '#1F2842', onSurface: '#EEF1F7' };

const paper: World = {
  id: 'paper',
  label: 'Paper',
  icon: '📄',
  background: 'paper',
  sky: ['#F7F4EE', '#EFEAE1'],
  dark: false,
  ...LIGHT_SURFACE,
  palette: [...LIGHT_PALETTE],
  particle: 'confetti',
  gravity: 40,
  energy: 0.9,
  timbre: 'felt',
  rootMidi: 60, // C4
  friends: ['🐻', '🐰', '🦊', '🐼', '🐨', '🐸', '🐥', '🐢', '🦉', '🐳'],
};

const garden: World = {
  id: 'garden',
  label: 'Garden',
  icon: '🌻',
  background: 'meadow',
  sky: ['#E8F2F7', '#F2F0E2'],
  dark: false,
  ...LIGHT_SURFACE,
  palette: [...LIGHT_PALETTE],
  particle: 'petals',
  gravity: 18,
  energy: 0.9,
  timbre: 'kalimba',
  rootMidi: 62, // D4
  friends: ['🌸', '🌼', '🌻', '🌷', '🦋', '🐝', '🐞', '🐛', '🐌', '🐦', '🐇', '🍓'],
  words: {
    B: [{ word: 'butterfly', emoji: '🦋' }, { word: 'bee', emoji: '🐝' }],
    F: [{ word: 'flower', emoji: '🌸' }],
    L: [{ word: 'ladybug', emoji: '🐞' }],
    S: [{ word: 'sunflower', emoji: '🌻' }, { word: 'snail', emoji: '🐌' }],
    T: [{ word: 'tulip', emoji: '🌷' }],
  },
};

const ocean: World = {
  id: 'ocean',
  label: 'Under the Sea',
  icon: '🐠',
  background: 'ocean',
  sky: ['#E4F0F5', '#CCE2EC'],
  dark: false,
  ...LIGHT_SURFACE,
  palette: [...LIGHT_PALETTE],
  particle: 'bubbles',
  gravity: -20,
  energy: 0.85,
  timbre: 'marimba',
  rootMidi: 60, // C4
  friends: ['🐠', '🐟', '🐡', '🐙', '🦀', '🐬', '🐳', '🦈', '🐚', '🐢', '🦑', '🦞'],
  words: {
    C: [{ word: 'crab', emoji: '🦀' }],
    D: [{ word: 'dolphin', emoji: '🐬' }],
    O: [{ word: 'octopus', emoji: '🐙' }],
    S: [{ word: 'shark', emoji: '🦈' }, { word: 'shell', emoji: '🐚' }],
    T: [{ word: 'turtle', emoji: '🐢' }],
    W: [{ word: 'whale', emoji: '🐳' }],
  },
};

const space: World = {
  id: 'space',
  label: 'Outer Space',
  icon: '🚀',
  background: 'space',
  sky: ['#161D33', '#0F1424'],
  dark: true,
  ...DARK_SURFACE,
  palette: [...DARK_PALETTE],
  particle: 'stars',
  gravity: 4,
  energy: 0.8,
  timbre: 'celesta',
  rootMidi: 64, // E4
  friends: ['🚀', '🪐', '🌙', '⭐', '🛸', '👽', '🌍', '☄️', '🛰️', '🔭'],
  words: {
    A: [{ word: 'alien', emoji: '👽' }],
    C: [{ word: 'comet', emoji: '☄️' }],
    E: [{ word: 'earth', emoji: '🌍' }],
    M: [{ word: 'moon', emoji: '🌙' }],
    P: [{ word: 'planet', emoji: '🪐' }],
    R: [{ word: 'rocket', emoji: '🚀' }],
    S: [{ word: 'star', emoji: '⭐' }, { word: 'satellite', emoji: '🛰️' }],
    T: [{ word: 'telescope', emoji: '🔭' }],
  },
};

const jungle: World = {
  id: 'jungle',
  label: 'Dino Jungle',
  icon: '🦕',
  background: 'jungle',
  sky: ['#EEF2E5', '#E1E9D4'],
  dark: false,
  ...LIGHT_SURFACE,
  palette: [...LIGHT_PALETTE],
  particle: 'leaves',
  gravity: 25,
  energy: 0.95,
  timbre: 'marimba',
  rootMidi: 57, // A3: a deeper, earthy register
  friends: ['🦕', '🦖', '🌴', '🥚', '🌿', '🐊', '🦎', '🐢', '🦜', '🐒', '🦁', '🐯'],
  words: {
    C: [{ word: 'crocodile', emoji: '🐊' }],
    D: [{ word: 'dinosaur', emoji: '🦕' }],
    E: [{ word: 'egg', emoji: '🥚' }],
    L: [{ word: 'lion', emoji: '🦁' }, { word: 'lizard', emoji: '🦎' }],
    M: [{ word: 'monkey', emoji: '🐒' }],
    P: [{ word: 'parrot', emoji: '🦜' }, { word: 'palm tree', emoji: '🌴' }],
    T: [{ word: 'tiger', emoji: '🐯' }, { word: 't-rex', emoji: '🦖' }],
  },
};

const snow: World = {
  id: 'snow',
  label: 'Snowy Hills',
  icon: '⛄',
  background: 'snow',
  sky: ['#EEF4FA', '#E2EBF4'],
  dark: false,
  ...LIGHT_SURFACE,
  palette: [...LIGHT_PALETTE],
  particle: 'snow',
  gravity: 14,
  energy: 0.75,
  timbre: 'harp',
  rootMidi: 65, // F4
  friends: ['🐧', '⛄', '❄️', '🦭', '🦊', '🐇', '🦌', '🧤', '🧣', '🛷', '🦉'],
  words: {
    D: [{ word: 'deer', emoji: '🦌' }],
    M: [{ word: 'mittens', emoji: '🧤' }],
    P: [{ word: 'penguin', emoji: '🐧' }],
    S: [{ word: 'snowman', emoji: '⛄' }, { word: 'sled', emoji: '🛷' }, { word: 'seal', emoji: '🦭' }],
  },
};

const night: World = {
  id: 'night',
  label: 'Night Sky',
  icon: '🌙',
  background: 'night',
  sky: ['#151C34', '#0E1326'],
  dark: true,
  ...DARK_SURFACE,
  palette: [...DARK_PALETTE],
  particle: 'dots',
  gravity: -4,
  energy: 0.6,
  timbre: 'soft',
  rootMidi: 57, // A3: low and sleepy
  friends: ['🌙', '⭐', '🦉', '🧸', '☁️', '🐑', '🦔', '🐻', '🛏️', '🌟'],
  words: {
    B: [{ word: 'bed', emoji: '🛏️' }, { word: 'bear', emoji: '🐻' }],
    M: [{ word: 'moon', emoji: '🌙' }],
    O: [{ word: 'owl', emoji: '🦉' }],
    S: [{ word: 'star', emoji: '⭐' }, { word: 'sheep', emoji: '🐑' }],
    T: [{ word: 'teddy', emoji: '🧸' }],
  },
};

export const WORLDS: Record<WorldId, World> = { paper, garden, ocean, space, jungle, snow, night };

/** Picker / auto-rotate order: the calm light default first, bedtime last. */
export const WORLD_ORDER: WorldId[] = ['paper', 'garden', 'ocean', 'space', 'jungle', 'snow', 'night'];

/** The world after `id` in WORLD_ORDER, wrapping around. */
export function nextWorld(id: WorldId): WorldId {
  const i = WORLD_ORDER.indexOf(id);
  return WORLD_ORDER[(i + 1) % WORLD_ORDER.length];
}
