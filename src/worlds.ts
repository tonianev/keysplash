/**
 * The seven play worlds. Each one has its own sky, palette, particles,
 * physics, instrument and cast of emoji friends.
 *
 * Palette rules: dark skies get bright saturated colours; light skies (garden,
 * bubbles) get deeper saturated colours. Every colour keeps at least ~3.5:1
 * contrast against its sky (checked in tests/content.test.ts).
 *
 * Emoji rules: Unicode 12 or older where possible (never newer than 13), no
 * ZWJ sequences, so everything renders on 2020-era Macs, iPads and Chromebooks.
 */
import type { World, WorldId } from './types';

const space: World = {
  id: 'space',
  label: 'Outer Space',
  icon: '🚀',
  background: 'starfield',
  sky: ['#0b1026', '#2b1d62'],
  dark: true,
  palette: [
    { name: 'red', hex: '#ff5c6c' },
    { name: 'orange', hex: '#ffa53a' },
    { name: 'yellow', hex: '#ffe14d' },
    { name: 'green', hex: '#5ef08a' },
    { name: 'blue', hex: '#5cc8ff' },
    { name: 'purple', hex: '#b98cff' },
    { name: 'pink', hex: '#ff7fd0' },
  ],
  particle: 'spark',
  gravity: 4,
  energy: 1,
  timbre: 'bell',
  rootMidi: 64, // E4
  friends: ['🚀', '🪐', '🌙', '⭐', '🛸', '👽', '🌍', '☄️', '🌟', '🛰️', '🔭', '🌠'],
  words: {
    A: [{ word: 'alien', emoji: '👽' }],
    C: [{ word: 'comet', emoji: '☄️' }],
    E: [{ word: 'earth', emoji: '🌍' }],
    M: [{ word: 'moon', emoji: '🌙' }],
    P: [{ word: 'planet', emoji: '🪐' }],
    R: [{ word: 'rocket', emoji: '🚀' }],
    S: [
      { word: 'star', emoji: '⭐' },
      { word: 'satellite', emoji: '🛰️' },
    ],
    T: [{ word: 'telescope', emoji: '🔭' }],
  },
};

const ocean: World = {
  id: 'ocean',
  label: 'Under the Sea',
  icon: '🐠',
  background: 'underwater',
  sky: ['#0a4d66', '#03263a'],
  dark: true,
  palette: [
    { name: 'yellow', hex: '#ffe066' },
    { name: 'orange', hex: '#ffa552' },
    { name: 'red', hex: '#ff8080' },
    { name: 'green', hex: '#7cf29c' },
    { name: 'pink', hex: '#ff8fd6' },
    { name: 'purple', hex: '#c9a2ff' },
    { name: 'white', hex: '#ffffff' },
  ],
  particle: 'bubble',
  gravity: -25,
  energy: 0.9,
  timbre: 'marimba',
  rootMidi: 60, // C4
  friends: ['🐠', '🐟', '🐡', '🐙', '🦀', '🐬', '🐳', '🦈', '🐚', '🐢', '🦑', '🦞'],
  words: {
    C: [{ word: 'crab', emoji: '🦀' }],
    D: [{ word: 'dolphin', emoji: '🐬' }],
    F: [{ word: 'fish', emoji: '🐠' }],
    L: [{ word: 'lobster', emoji: '🦞' }],
    O: [{ word: 'octopus', emoji: '🐙' }],
    P: [{ word: 'pufferfish', emoji: '🐡' }],
    S: [
      { word: 'shark', emoji: '🦈' },
      { word: 'shell', emoji: '🐚' },
    ],
    T: [{ word: 'turtle', emoji: '🐢' }],
    W: [{ word: 'whale', emoji: '🐳' }],
  },
};

const garden: World = {
  id: 'garden',
  label: 'Garden',
  icon: '🌻',
  background: 'meadow',
  sky: ['#b9e3ff', '#e6f8d4'],
  dark: false,
  palette: [
    { name: 'red', hex: '#d62839' },
    { name: 'orange', hex: '#b84a00' },
    { name: 'green', hex: '#1f7a35' },
    { name: 'blue', hex: '#1d5fbf' },
    { name: 'purple', hex: '#7a2fbf' },
    { name: 'pink', hex: '#c2185b' },
  ],
  particle: 'petal',
  gravity: 18,
  energy: 1,
  timbre: 'kalimba',
  rootMidi: 62, // D4
  friends: ['🌸', '🌼', '🌻', '🌷', '🦋', '🐝', '🐞', '🐛', '🐌', '🍓', '🐦', '🐇'],
  words: {
    B: [
      { word: 'bee', emoji: '🐝' },
      { word: 'butterfly', emoji: '🦋' },
    ],
    C: [{ word: 'caterpillar', emoji: '🐛' }],
    F: [{ word: 'flower', emoji: '🌼' }],
    L: [{ word: 'ladybug', emoji: '🐞' }],
    R: [{ word: 'rabbit', emoji: '🐇' }],
    S: [
      { word: 'snail', emoji: '🐌' },
      { word: 'sunflower', emoji: '🌻' },
    ],
    T: [{ word: 'tulip', emoji: '🌷' }],
  },
};

const party: World = {
  id: 'party',
  label: 'Party',
  icon: '🎉',
  background: 'party',
  sky: ['#2a0b3d', '#5e1252'],
  dark: true,
  palette: [
    { name: 'yellow', hex: '#ffe14d' },
    { name: 'orange', hex: '#ffa53a' },
    { name: 'red', hex: '#ff6b6b' },
    { name: 'green', hex: '#5ef08a' },
    { name: 'blue', hex: '#5cc8ff' },
    { name: 'pink', hex: '#ff8ad8' },
    { name: 'white', hex: '#ffffff' },
  ],
  particle: 'confetti',
  gravity: 70,
  energy: 1.3,
  timbre: 'pluck',
  rootMidi: 65, // F4
  friends: ['🎈', '🎉', '🎁', '🧁', '🍰', '🍭', '🎊', '🥳', '🍩', '🎂', '🍦', '🍬'],
  words: {
    B: [{ word: 'balloon', emoji: '🎈' }],
    C: [
      { word: 'cupcake', emoji: '🧁' },
      { word: 'cake', emoji: '🎂' },
    ],
    D: [{ word: 'donut', emoji: '🍩' }],
    G: [{ word: 'gift', emoji: '🎁' }],
    L: [{ word: 'lollipop', emoji: '🍭' }],
    M: [{ word: 'music', emoji: '🎵' }],
    P: [
      { word: 'present', emoji: '🎁' },
      { word: 'party', emoji: '🥳' },
    ],
  },
};

const bubbles: World = {
  id: 'bubbles',
  label: 'Bath Bubbles',
  icon: '🛁',
  background: 'bubbles',
  sky: ['#e8dcff', '#cdeeff'],
  dark: false,
  palette: [
    { name: 'red', hex: '#cc2638' },
    { name: 'orange', hex: '#b34800' },
    { name: 'green', hex: '#1d7f3c' },
    { name: 'blue', hex: '#1c5bc4' },
    { name: 'purple', hex: '#7b2ec4' },
    { name: 'pink', hex: '#c2185b' },
  ],
  particle: 'bubble',
  gravity: -14,
  energy: 0.9,
  timbre: 'bubble',
  rootMidi: 67, // G4
  friends: ['🦆', '🐥', '🐳', '🧼', '🌈', '⭐', '💧', '🐠', '🐸', '🧸'],
  words: {
    B: [{ word: 'bath', emoji: '🛁' }],
    C: [{ word: 'chick', emoji: '🐥' }],
    D: [{ word: 'duck', emoji: '🦆' }],
    F: [{ word: 'frog', emoji: '🐸' }],
    R: [{ word: 'rainbow', emoji: '🌈' }],
    S: [
      { word: 'soap', emoji: '🧼' },
      { word: 'splash', emoji: '💦' },
    ],
    T: [{ word: 'teddy', emoji: '🧸' }],
    W: [{ word: 'water', emoji: '💧' }],
  },
};

const dino: World = {
  id: 'dino',
  label: 'Dino Land',
  icon: '🦕',
  background: 'jungle',
  sky: ['#17522e', '#082a17'],
  dark: true,
  palette: [
    { name: 'yellow', hex: '#ffe14d' },
    { name: 'orange', hex: '#ffad4d' },
    { name: 'red', hex: '#ff8a80' },
    { name: 'blue', hex: '#6cd0ff' },
    { name: 'purple', hex: '#c9a2ff' },
    { name: 'pink', hex: '#ff8fd6' },
    { name: 'white', hex: '#ffffff' },
  ],
  particle: 'leaf',
  gravity: 30,
  energy: 1.1,
  timbre: 'marimba',
  rootMidi: 57, // A3: a deeper, stompier marimba than the ocean's
  friends: ['🦕', '🦖', '🌋', '🌴', '🥚', '🌿', '🐊', '🦎', '🐢', '🐉'],
  words: {
    C: [{ word: 'crocodile', emoji: '🐊' }],
    D: [{ word: 'dinosaur', emoji: '🦕' }],
    E: [{ word: 'egg', emoji: '🥚' }],
    L: [
      { word: 'lizard', emoji: '🦎' },
      { word: 'leaf', emoji: '🌿' },
    ],
    P: [{ word: 'palm tree', emoji: '🌴' }],
    R: [{ word: 'roar', emoji: '🦖' }],
    T: [{ word: 't-rex', emoji: '🦖' }],
    V: [{ word: 'volcano', emoji: '🌋' }],
  },
};

const night: World = {
  id: 'night',
  label: 'Night Sky',
  icon: '🌙',
  background: 'night',
  sky: ['#0a0f2e', '#1d2557'],
  dark: true,
  palette: [
    { name: 'yellow', hex: '#ffe680' },
    { name: 'orange', hex: '#ffb86b' },
    { name: 'green', hex: '#8af0b0' },
    { name: 'blue', hex: '#7fd4ff' },
    { name: 'purple', hex: '#c3a6ff' },
    { name: 'pink', hex: '#ffa3d9' },
    { name: 'white', hex: '#f4f1ff' },
  ],
  particle: 'firefly',
  gravity: -5,
  energy: 0.6,
  timbre: 'soft',
  rootMidi: 59, // B3: low and sleepy
  friends: ['🌙', '⭐', '🦉', '🧸', '🌟', '☁️', '🐑', '🦔', '🐻', '🌛'],
  words: {
    B: [
      { word: 'bed', emoji: '🛏️' },
      { word: 'bear', emoji: '🐻' },
    ],
    C: [{ word: 'cloud', emoji: '☁️' }],
    H: [{ word: 'hedgehog', emoji: '🦔' }],
    M: [{ word: 'moon', emoji: '🌛' }],
    N: [{ word: 'night', emoji: '🌙' }],
    O: [{ word: 'owl', emoji: '🦉' }],
    S: [
      { word: 'star', emoji: '⭐' },
      { word: 'sheep', emoji: '🐑' },
    ],
    T: [{ word: 'teddy', emoji: '🧸' }],
  },
};

export const WORLDS: Record<WorldId, World> = { space, ocean, garden, party, bubbles, dino, night };

/** Picker order and auto-rotate order. */
export const WORLD_ORDER: WorldId[] = ['space', 'ocean', 'garden', 'party', 'bubbles', 'dino', 'night'];

/** The world after `id` in WORLD_ORDER, wrapping around (unknown ids start over). */
export function nextWorld(id: WorldId): WorldId {
  const i = WORLD_ORDER.indexOf(id);
  return WORLD_ORDER[(i + 1) % WORLD_ORDER.length];
}
