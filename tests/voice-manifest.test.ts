/**
 * The generated natural voice (src/voice/manifest.json + public/voice/*.mp3)
 * covers every line the app can say, and every clip it references exists.
 * Regenerate with `npm run voice` when this fails after a wording change.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClipManifest } from '../src/audio/clip-voice';
import manifestJson from '../src/voice/manifest.json';
import { allVoiceUnits } from '../src/voice/inventory';
import { describeVoiceCoverage } from './voice-coverage';

const manifest = manifestJson as unknown as ClipManifest;
const VOICE_DIR = `${resolve(process.cwd(), 'public/voice')}/`;

describe('voice manifest', () => {
  const entries = Object.entries(manifest.clips);

  it('has a clip for every inventory unit', () => {
    const missing = allVoiceUnits().filter((u) => !Object.hasOwn(manifest.clips, u.key)).map((u) => u.key);
    expect(missing).toEqual([]);
  });

  it('references only clips that exist in public/voice, with sane durations', () => {
    expect(entries.length).toBeGreaterThan(300);
    for (const [key, [id, ms]] of entries) {
      expect(id, key).toMatch(/^[0-9a-f]{10}$/);
      expect(existsSync(`${VOICE_DIR}${id}.mp3`), `${key} → ${id}.mp3`).toBe(true);
      expect(statSync(`${VOICE_DIR}${id}.mp3`).size, key).toBeGreaterThan(500);
      expect(ms, key).toBeGreaterThan(100);
      expect(ms, key).toBeLessThan(10_000);
    }
  });

  it('ships no unreferenced clips', () => {
    const ids = new Set(entries.map(([, [id]]) => `${id}.mp3`));
    const stray = readdirSync(VOICE_DIR).filter((f) => f.endsWith('.mp3') && !ids.has(f));
    expect(stray).toEqual([]);
  });
});

describeVoiceCoverage('voice manifest coverage: every line the app says has a generated clip', manifest.clips);
