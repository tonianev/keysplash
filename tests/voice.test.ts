import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipVoice, SEQUENCE_LOAD_LIMIT_MS } from '../src/audio/clip-voice';
import { VoiceRouter } from '../src/audio/voice-router';
import type { VoiceOutput, VoicePlayback } from '../src/types';
import { FakeSpeaker } from './fakes';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClip extends AudioBuffer {
  id: string;
}

interface Play {
  id: string;
  when: number | undefined;
  stopped: boolean;
  end: () => void;
}

/** VoiceOutput with a hand-driven clock; buffers carry the clip id. */
class FakeOutput implements VoiceOutput {
  time: number | null = 0;
  plays: Play[] = [];
  decodes = 0;
  readonly ids = new WeakMap<ArrayBuffer, string>();
  durations: Record<string, number> = {};

  currentTime(): number | null {
    return this.time;
  }
  decodeAudio(data: ArrayBuffer): Promise<AudioBuffer | null> {
    this.decodes++;
    const id = this.ids.get(data);
    if (!id || this.time === null) return Promise.resolve(null);
    return Promise.resolve({ id, duration: this.durations[id] ?? 0.4 } as unknown as AudioBuffer);
  }
  playVoice(buffer: AudioBuffer, when?: number): VoicePlayback | null {
    if (this.time === null) return null;
    let end = (): void => {};
    const ended = new Promise<void>((resolve) => (end = resolve));
    const play: Play = { id: (buffer as FakeClip).id, when, stopped: false, end };
    this.plays.push(play);
    return {
      endTime: (when ?? this.time) + buffer.duration,
      stop: () => {
        play.stopped = true;
        end();
      },
      ended,
    };
  }
  get played(): string[] {
    return this.plays.map((p) => p.id);
  }
}

/** fetch() for ./voice/<id>.mp3; `hold` keeps responses pending until release(). */
function fakeFetch(output: FakeOutput) {
  const urls: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const fn = vi.fn((url: string) => {
    urls.push(url);
    const id = decodeURIComponent(url.replace(/^.*\//, '').replace(/\.mp3$/, ''));
    const respond = () => {
      const data = new ArrayBuffer(8);
      output.ids.set(data, id);
      return { ok: id !== 'missing', arrayBuffer: () => Promise.resolve(data) } as unknown as Response;
    };
    if (!hold) return Promise.resolve(respond());
    return new Promise<Response>((resolve) => held.push(() => resolve(respond())));
  });
  return {
    fn: fn as unknown as typeof fetch,
    urls,
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => held.splice(0).forEach((r) => r()),
  };
}

const MANIFEST = {
  clips: {
    bee: ['bee', 300],
    'yes!': ['yes', 300],
    "that's bee!": ['thatsbee', 500],
    "yes! that's see!": ['yessee', 900],
    one: ['one', 300],
    two: ['two', 300],
    three: ['three', 300],
    'three stars!': ['stars', 600],
    "let's play!": ['play', 600],
    'yay!': ['yay', 300],
    'hello!': ['hello', 300],
    oops: ['missing', 300],
  } as Record<string, [string, number]>,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function setup(options: { fallback?: FakeSpeaker | null; cacheSize?: number; warmLines?: string[] } = {}) {
  const output = new FakeOutput();
  const fetcher = fakeFetch(output);
  const voice = new ClipVoice(output, MANIFEST, {
    fetchFn: fetcher.fn,
    now: () => Date.now(),
    fallback: options.fallback ?? null,
    cacheSize: options.cacheSize,
    warmLines: options.warmLines ?? ['bee', 'one', "Let's play!", 'not covered'],
  });
  return { output, fetcher, voice };
}

// ---------------------------------------------------------------------------
// ClipVoice
// ---------------------------------------------------------------------------

describe('ClipVoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it('is supported and plays a whole-line clip from ./voice/<id>.mp3', async () => {
    const { output, fetcher, voice } = setup();
    expect(voice.supported).toBe(true);
    voice.say('Bee', 'high');
    await flush();
    expect(fetcher.urls).toEqual(['./voice/bee.mp3']);
    expect(output.played).toEqual(['bee']);
    expect(output.plays[0].when).toBeCloseTo(0.02);
  });

  it('prefers the full-line clip over sentences', async () => {
    const { output, voice } = setup();
    voice.say("Yes! That's see!", 'high');
    await flush();
    expect(output.played).toEqual(['yessee']);
  });

  it('plays sentence clips back to back with a short gap', async () => {
    const { output, voice } = setup();
    output.durations.yes = 0.5;
    voice.say("Yes!  That’s bee!", 'high');
    await flush();
    expect(output.played).toEqual(['yes']);
    // The second sentence is handed over shortly before it is due.
    vi.advanceTimersByTime(1000);
    expect(output.played).toEqual(['yes', 'thatsbee']);
    expect(output.plays[1].when! - output.plays[0].when!).toBeCloseTo(0.5 + 0.07);
  });

  it('low priority is skipped while busy or within 300 ms; high cuts in', async () => {
    const { output, voice } = setup();
    voice.say('bee');
    await flush();
    voice.say('one'); // too soon / still loading-playing
    await flush();
    expect(output.played).toEqual(['bee']);
    vi.advanceTimersByTime(350);
    output.time = 0.1; // clip (0.4 s from 0.02) still playing
    voice.say('two');
    await flush();
    expect(output.played).toEqual(['bee']);
    voice.say('three', 'high');
    await flush();
    expect(output.plays[0].stopped).toBe(true);
    expect(output.played).toEqual(['bee', 'three']);
    vi.advanceTimersByTime(400);
    output.time = 2;
    voice.say('one');
    await flush();
    expect(output.played).toEqual(['bee', 'three', 'one']);
  });

  it('sequences parts on context time, then the closing line after the last part + 0.25 s', async () => {
    const { output, voice } = setup();
    output.time = 5;
    voice.sequence(['one', 'two', 'three'], 600, 'three stars!');
    expect(voice.sequencing).toBe(true);
    await flush();
    vi.advanceTimersByTime(3000);
    expect(output.played).toEqual(['one', 'two', 'three', 'stars']);
    const whens = output.plays.map((p) => p.when!);
    expect(whens[0]).toBeCloseTo(5.02);
    expect(whens[1]).toBeCloseTo(5.62);
    expect(whens[2]).toBeCloseTo(6.22);
    expect(whens[3]).toBeCloseTo(6.22 + 0.4 + 0.25);
    expect(voice.sequencing).toBe(false);
  });

  it('schedules lazily so only near-due clips are handed to the engine', async () => {
    const { output, voice } = setup();
    voice.sequence(['one', 'two', 'three'], 1000);
    await flush();
    expect(output.played).toEqual(['one']);
    vi.advanceTimersByTime(900);
    expect(output.played).toEqual(['one', 'two']);
  });

  it('drops a sequence whose clips take longer than 600 ms to load', async () => {
    const { output, fetcher, voice } = setup();
    fetcher.hold(true);
    voice.sequence(['one', 'two'], 500);
    vi.advanceTimersByTime(SEQUENCE_LOAD_LIMIT_MS + 10);
    expect(voice.sequencing).toBe(false);
    fetcher.release();
    await flush();
    vi.advanceTimersByTime(3000);
    expect(output.played).toEqual([]);
    expect(voice.cached).toBe(2); // still cached for next time
  });

  it('cancel() stops the playing clip, scheduled clips and pending loads', async () => {
    const fallback = new FakeSpeaker();
    const { output, fetcher, voice } = setup({ fallback });
    voice.sequence(['one', 'two', 'three'], 1000);
    await flush();
    voice.cancel();
    expect(output.plays[0].stopped).toBe(true);
    expect(voice.sequencing).toBe(false);
    expect(fallback.cancels).toBeGreaterThan(0);
    vi.advanceTimersByTime(5000);
    expect(output.played).toEqual(['one']);
    fetcher.hold(true);
    voice.say('bee', 'high');
    expect(fetcher.urls.at(-1)).toBe('./voice/bee.mp3');
    voice.cancel();
    fetcher.release();
    await flush();
    expect(output.played).toEqual(['one']);
  });

  it('sends uncovered lines to the fallback speaker, else stays silent', async () => {
    const fallback = new FakeSpeaker();
    const { output, voice } = setup({ fallback });
    voice.say('Hi Mia!', 'high');
    voice.sequence(['one', 'eleventy'], 500, null);
    expect(fallback.said).toEqual([{ text: 'Hi Mia!', priority: 'high' }]);
    expect(fallback.lastSequence?.parts).toEqual(['one', 'eleventy']);
    await flush();
    expect(output.played).toEqual([]);

    const silent = setup();
    expect(() => silent.voice.say('Hi Mia!', 'high')).not.toThrow();
    await flush();
    expect(silent.output.played).toEqual([]);
    expect(silent.voice.voices()).toEqual([]);
  });

  it('falls back when a clip fails to load', async () => {
    const fallback = new FakeSpeaker();
    const { output, voice } = setup({ fallback });
    voice.say('oops', 'high');
    await flush();
    expect(output.played).toEqual([]);
    expect(fallback.texts).toEqual(['oops']);
  });

  it('keeps decoded clips in a bounded LRU', async () => {
    const { fetcher, voice } = setup({ cacheSize: 2 });
    for (const word of ['one', 'two', 'one', 'three', 'one', 'two']) {
      voice.say(word, 'high');
      await flush();
    }
    expect(voice.cached).toBe(2);
    // one stays hot; two was evicted by three, so it is fetched again.
    expect(fetcher.urls.map((u) => u.replace('./voice/', ''))).toEqual(['one.mp3', 'two.mp3', 'three.mp3', 'two.mp3']);
  });

  it('dedupes in-flight fetches of the same clip', async () => {
    const { output, fetcher, voice } = setup();
    fetcher.hold(true);
    voice.say('bee', 'high');
    voice.say('bee', 'high');
    voice.warm();
    await flush();
    expect(fetcher.urls.filter((u) => u.endsWith('/bee.mp3'))).toHaveLength(1);
    fetcher.release();
    await flush();
    expect(output.played).toEqual(['bee']);
    expect(output.decodes).toBe(fetcher.urls.length);
  });

  it('warm() prefetches the warm lines without playing; not before unlock', async () => {
    const locked = setup();
    locked.output.time = null;
    locked.voice.warm();
    expect(locked.fetcher.urls).toEqual([]);

    const { output, fetcher, voice } = setup();
    voice.warm();
    await flush();
    await flush();
    expect(fetcher.urls.sort()).toEqual(['./voice/bee.mp3', './voice/one.mp3', './voice/play.mp3']);
    expect(voice.cached).toBe(3);
    expect(output.played).toEqual([]);
  });

  it('default warm lines cover letters, numbers and the short cheers', async () => {
    const { defaultWarmLines } = await import('../src/audio/clip-voice');
    const list = defaultWarmLines();
    expect(list).toContain('bee');
    expect(list).toContain('double you');
    expect(list).toContain('ten');
    expect(list).toEqual(expect.arrayContaining(["Let's play!", 'Yay!', 'Yes!', 'Hello!']));
    expect(list.length).toBeLessThanOrEqual(120);
  });

  it('is silent while disabled and works again when re-enabled', async () => {
    const fallback = new FakeSpeaker();
    const { output, fetcher, voice } = setup({ fallback });
    voice.setEnabled(false);
    voice.say('bee', 'high');
    voice.say('Hi Mia!', 'high');
    voice.sequence(['one'], 100, 'three stars!');
    await flush();
    vi.advanceTimersByTime(2000);
    expect(fetcher.urls).toEqual([]);
    expect(output.played).toEqual([]);
    expect(fallback.said).toEqual([]);
    voice.setEnabled(true);
    voice.say('bee', 'high');
    await flush();
    expect(output.played).toEqual(['bee']);
  });

  it('setEnabled(false) stops what is playing', async () => {
    const { output, voice } = setup();
    voice.say('bee', 'high');
    await flush();
    voice.setEnabled(false);
    expect(output.plays[0].stopped).toBe(true);
  });

  it('passes voice listing/selection to the fallback', () => {
    const fallback = new FakeSpeaker();
    const { voice } = setup({ fallback });
    voice.setVoice('uri:x');
    expect(fallback.voice).toBe('uri:x');
    expect(typeof voice.onVoicesChanged(() => {})).toBe('function');
    expect(() => voice.setVolume(0.3)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VoiceRouter
// ---------------------------------------------------------------------------

describe('VoiceRouter', () => {
  function router(style?: 'natural' | 'device') {
    const natural = new FakeSpeaker();
    const device = new FakeSpeaker();
    return { natural, device, voice: new VoiceRouter(natural, device, style) };
  }

  it('defaults to the natural voice and routes speaking to it', () => {
    const { natural, device, voice } = router();
    expect(voice.currentStyle).toBe('natural');
    voice.say('bee', 'high');
    voice.sequence(['one'], 500, 'one star!');
    voice.warm();
    expect(natural.said).toEqual([{ text: 'bee', priority: 'high' }]);
    expect(natural.lastSequence).toEqual({ parts: ['one'], stepMs: 500, then: 'one star!' });
    expect(natural.warms).toBe(1);
    expect(device.said).toEqual([]);
    expect(device.sequences).toEqual([]);
  });

  it('setStyle switches speakers and cancels the one it leaves', () => {
    const { natural, device, voice } = router();
    voice.setStyle('device');
    expect(natural.cancels).toBe(1);
    voice.say('Hi Mia!');
    expect(device.texts).toEqual(['Hi Mia!']);
    device.sequencing = true;
    expect(voice.sequencing).toBe(true);
    voice.setStyle('device'); // no change, no cancel
    expect(device.cancels).toBe(0);
    voice.setStyle('natural');
    expect(device.cancels).toBe(1);
    expect(voice.sequencing).toBe(false);
  });

  it('starts in the given style', () => {
    const { device, voice } = router('device');
    voice.say('bee');
    expect(device.texts).toEqual(['bee']);
  });

  it('enable/volume/cancel reach both; voice list comes from the device', () => {
    const { natural, device, voice } = router();
    voice.setEnabled(false);
    voice.setVolume(0.4);
    voice.cancel();
    expect([natural.enabled, device.enabled]).toEqual([false, false]);
    expect([natural.volume, device.volume]).toEqual([0.4, 0.4]);
    expect([natural.cancels, device.cancels]).toEqual([1, 1]);
    voice.setVoice('uri:Ava');
    expect(device.voice).toBe('uri:Ava');
    expect(natural.voice).toBeNull();
    const spy = vi.spyOn(device, 'voices');
    voice.voices();
    expect(spy).toHaveBeenCalled();
    expect(voice.supported).toBe(true);
  });

  it('supported follows the active speaker', () => {
    const natural = new FakeSpeaker();
    const device = { ...new FakeSpeaker(), supported: false } as unknown as FakeSpeaker;
    const voice = new VoiceRouter(natural, device);
    expect(voice.supported).toBe(true);
    voice.setStyle('device');
    expect(voice.supported).toBe(false);
  });
});
