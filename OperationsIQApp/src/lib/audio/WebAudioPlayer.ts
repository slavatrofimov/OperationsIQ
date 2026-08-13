/**
 * Thin Web Audio transport for sonification playback. It schedules a list of
 * pre-computed {@link NoteEvent}s (from `sonify()`) on a single `AudioContext`,
 * one oscillator + gain node per note, with short attack/release ramps to avoid
 * clicks. All the musical logic lives in `sonify.ts`; this file is deliberately
 * logic-light (jsdom has no AudioContext, so it isn't unit-tested).
 *
 * Transport: load() -> play()/pause()/stop(). A requestAnimationFrame loop
 * reports playback position via `onTick` so the page can move a playhead. The
 * design is single-voice today but nothing here assumes one series — a future
 * multi-voice mixer can schedule several note lists on the same context.
 */
import type { NoteEvent, Waveform } from '../sonify';

export interface WebAudioPlayerCallbacks {
  /** Called on each animation frame with the current playback position (seconds). */
  onTick?: (currentSec: number) => void;
  /** Called once when playback reaches the end (not on manual stop). */
  onEnded?: () => void;
  /** Called when play/pause state changes, for UI sync. */
  onStateChange?: (playing: boolean) => void;
}

type ScheduledVoice = { osc: OscillatorNode; gain: GainNode };

const ATTACK_SEC = 0.008;
const RELEASE_SEC = 0.012;

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** True when the running environment can synthesize audio. */
export function isAudioSupported(): boolean {
  return getAudioContextCtor() !== undefined;
}

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private notes: NoteEvent[] = [];
  private totalDurationSec = 0;
  private waveform: Waveform = 'sine';
  private volume = 0.9;

  private voices: ScheduledVoice[] = [];
  /** ctx.currentTime captured when the current play() run started. */
  private runStartCtxTime = 0;
  /** Seconds into the piece at which the current run started (resume point). */
  private offsetSec = 0;
  private playing = false;
  private rafId: number | null = null;

  constructor(private callbacks: WebAudioPlayerCallbacks = {}) {}

  /** Replace the loaded score. Stops any current playback and rewinds. */
  load(notes: NoteEvent[], totalDurationSec: number, waveform: Waveform): void {
    this.stop();
    this.notes = notes;
    this.totalDurationSec = totalDurationSec;
    this.waveform = waveform;
    this.offsetSec = 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get durationSec(): number {
    return this.totalDurationSec;
  }

  setWaveform(waveform: Waveform): void {
    this.waveform = waveform;
  }

  /** Master volume in [0, 1]; applies immediately if playing. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  /** Start (or resume) playback from the current offset. */
  async play(): Promise<void> {
    if (this.playing || this.notes.length === 0) return;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    // Browsers start the context suspended until a user gesture resumes it.
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore — resume can reject if the gesture was lost */
      }
    }
    this.runStartCtxTime = this.ctx.currentTime;
    this.scheduleFrom(this.offsetSec);
    this.playing = true;
    this.callbacks.onStateChange?.(true);
    this.startTicking();
  }

  /** Pause and remember the position so a later play() resumes. */
  pause(): void {
    if (!this.playing || !this.ctx) return;
    this.offsetSec += this.ctx.currentTime - this.runStartCtxTime;
    this.teardownVoices();
    this.playing = false;
    this.stopTicking();
    this.callbacks.onStateChange?.(false);
  }

  /** Stop and rewind to the beginning. */
  stop(): void {
    this.teardownVoices();
    this.offsetSec = 0;
    if (this.playing) {
      this.playing = false;
      this.callbacks.onStateChange?.(false);
    }
    this.stopTicking();
    this.callbacks.onTick?.(0);
  }

  /** Release the AudioContext. Call on unmount. */
  dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }

  private scheduleFrom(offsetSec: number): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    for (const note of this.notes) {
      const noteEnd = note.startSec + note.durSec;
      if (noteEnd <= offsetSec) continue; // already played
      const when = now + Math.max(0, note.startSec - offsetSec);
      const dur = noteEnd - Math.max(note.startSec, offsetSec);
      this.scheduleNote(note, when, dur);
    }
  }

  private scheduleNote(note: NoteEvent, when: number, dur: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = this.waveform;
    osc.frequency.setValueAtTime(note.freq, when);

    const gain = this.ctx.createGain();
    const attack = Math.min(ATTACK_SEC, dur / 2);
    const release = Math.min(RELEASE_SEC, dur / 2);
    const peak = Math.max(0.0001, note.gain);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setValueAtTime(peak, when + dur - release);
    gain.gain.linearRampToValueAtTime(0.0001, when + dur);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.02);

    const voice: ScheduledVoice = { osc, gain };
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
      this.voices = this.voices.filter((v) => v !== voice);
    };
    this.voices.push(voice);
  }

  private teardownVoices(): void {
    for (const { osc, gain } of this.voices) {
      try {
        osc.onended = null;
        osc.stop();
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.voices = [];
  }

  private startTicking(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    const tick = () => {
      if (!this.playing || !this.ctx) return;
      const currentSec = this.offsetSec + (this.ctx.currentTime - this.runStartCtxTime);
      if (currentSec >= this.totalDurationSec) {
        this.callbacks.onTick?.(this.totalDurationSec);
        this.finish();
        return;
      }
      this.callbacks.onTick?.(currentSec);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTicking(): void {
    if (this.rafId != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private finish(): void {
    this.teardownVoices();
    this.offsetSec = 0;
    this.playing = false;
    this.stopTicking();
    this.callbacks.onStateChange?.(false);
    this.callbacks.onEnded?.();
  }
}
