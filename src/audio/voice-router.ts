/**
 * VoiceRouter: one Speaker that switches between the built-in natural voice
 * (ClipVoice) and the device voice (WebSpeaker). Speaking goes to the active
 * style; enable/volume reach both; the voice list always comes from the device.
 */
import type { Speaker, VoiceInfo, VoiceStyle } from '../types';

export class VoiceRouter implements Speaker {
  private style: VoiceStyle;

  constructor(
    private readonly natural: Speaker,
    private readonly device: Speaker,
    style: VoiceStyle = 'natural',
  ) {
    this.style = style === 'device' ? 'device' : 'natural';
  }

  private get active(): Speaker {
    return this.style === 'device' ? this.device : this.natural;
  }

  get supported(): boolean {
    return this.active.supported;
  }

  get sequencing(): boolean {
    return this.active.sequencing;
  }

  /** The current style (tests/diagnostics). */
  get currentStyle(): VoiceStyle {
    return this.style;
  }

  setStyle(style: VoiceStyle): void {
    const next: VoiceStyle = style === 'device' ? 'device' : 'natural';
    if (next === this.style) return;
    const previous = this.active;
    this.style = next;
    safely(() => previous.cancel());
  }

  setEnabled(enabled: boolean): void {
    safely(() => this.natural.setEnabled(enabled));
    safely(() => this.device.setEnabled(enabled));
  }

  setVolume(volume: number): void {
    safely(() => this.natural.setVolume(volume));
    safely(() => this.device.setVolume(volume));
  }

  setVoice(uri: string | null): void {
    this.device.setVoice(uri);
  }

  voices(): VoiceInfo[] {
    return this.device.voices();
  }

  onVoicesChanged(listener: () => void): () => void {
    return this.device.onVoicesChanged(listener);
  }

  say(text: string, priority: 'low' | 'high' = 'low'): void {
    this.active.say(text, priority);
  }

  sequence(parts: string[], stepMs: number, then?: string | null): void {
    this.active.sequence(parts, stepMs, then);
  }

  /** Reaches both: the natural voice may be speaking through its device fallback. */
  cancel(): void {
    safely(() => this.natural.cancel());
    safely(() => this.device.cancel());
  }

  warm(): void {
    this.active.warm?.();
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // One speaker failing must not stop the other.
  }
}
