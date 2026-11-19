// Audio Engine with real-time generative background music, Web Speech TTS, and auto-ducking.
//
// Synchronization contract:
// - Every narration / custom-audio start belongs to a monotonic "session".
//   Any callback (word boundary, fallback timer, end/error) captured by an
//   older session is dropped, so speech from a previous scene or a replaced
//   voice track can never touch the current subtitles.
// - Ducking state is tracked explicitly. Starting / restarting the music
//   loop always re-applies the current ducking state, and only a single
//   music interval loop can ever exist at a time.

export interface AudioPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  currentWordIndex: number;
  duckingActive: boolean;
}

export type WordBoundaryListener = (word: string, charIndex: number, wordIndex: number) => void;

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  /**
   * Playhead offset (seconds) at which the narration is being (re)started,
   * e.g. after a seek or resume. Word events for words estimated to have
   * already been spoken before the offset are suppressed.
   */
  startOffsetSec?: number;
  /**
   * Session token issued by the playback coordinator. The engine adopts it
   * as its active session id so callback staleness checks use one token
   * source of truth.
   */
  sessionToken?: number;
}

const MUSIC_BASE_GAIN = 0.25;
const MUSIC_DUCK_GAIN = 0.08;
// Estimated speaking rate used both for the no-boundary fallback timer and
// for mapping word indexes to times when seeking.
const WORDS_PER_SECOND_BASE = 2.6;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private musicPlaying = false;
  private musicInterval: number | null = null;
  private currentTrack = 'lofi';
  private speechUtterance: SpeechSynthesisUtterance | null = null;
  private wordListeners: Set<WordBoundaryListener> = new Set();
  private currentWordIndex: number = -1;
  private currentSpokenWord: string = '';
  private fallbackWordTimer: number | null = null;
  private hasReceivedNativeBoundary: boolean = false;

  /** Monotonic id of the current voice/audio session. */
  private activeSessionId = 0;
  /** Explicit ducking state so music (re)starts inherit the right volume. */
  private duckingActive = false;

  public getCurrentTrack(): string {
    return this.currentTrack;
  }

  public isSpeaking(): boolean {
    return Boolean(this.speechUtterance) || Boolean(this.customAudio);
  }

  public isDucking(): boolean {
    return this.duckingActive;
  }

  public isMusicPlaying(): boolean {
    return this.musicPlaying;
  }

  /** Exposed for tests / diagnostics: number of active music scheduler loops. */
  public getMusicLoopCount(): number {
    return this.musicInterval !== null ? 1 : 0;
  }

  /**
   * Begin a new voice/audio session and return its token. When an external
   * token is supplied (e.g. from the PlaybackCoordinator) the engine adopts
   * it; otherwise it advances its own monotonic counter.
   */
  public beginSession(externalToken?: number): number {
    if (typeof externalToken === 'number' && Number.isFinite(externalToken)) {
      // Never move backwards: take the max so a stale external token cannot
      // resurrect an invalidated session.
      this.activeSessionId = Math.max(this.activeSessionId + 1, externalToken);
    } else {
      this.activeSessionId += 1;
    }
    return this.activeSessionId;
  }

  public getActiveSessionId(): number {
    return this.activeSessionId;
  }

  public isSessionActive(sessionId: number): boolean {
    return sessionId === this.activeSessionId;
  }

  public addWordListener(listener: WordBoundaryListener): () => void {
    this.wordListeners.add(listener);
    if (this.currentWordIndex >= 0) {
      try {
        listener(this.currentSpokenWord, 0, this.currentWordIndex);
      } catch {
        // listener errors must not break playback
      }
    }
    return () => {
      this.wordListeners.delete(listener);
    };
  }

  public notifyWord(word: string, charIndex: number, wordIndex: number) {
    this.currentSpokenWord = word;
    this.currentWordIndex = wordIndex;
    this.wordListeners.forEach((listener) => {
      try {
        listener(word, charIndex, wordIndex);
      } catch (err) {
        console.error('Error in word listener:', err);
      }
    });
  }

  public getCurrentWord(): { word: string; index: number } {
    return { word: this.currentSpokenWord, index: this.currentWordIndex };
  }

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(
        this.duckingActive ? MUSIC_DUCK_GAIN : MUSIC_BASE_GAIN,
        this.ctx.currentTime
      );
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.setValueAtTime(0.4, this.ctx.currentTime);
      this.sfxGain.connect(this.masterGain);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  // Play Sound Effects
  public playPop() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(740, t + 0.08);

      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

      osc.connect(gain);
      gain.connect(this.sfxGain);

      osc.start(t);
      osc.stop(t + 0.1);
    } catch {
      // Audio fallback
    }
  }

  public playWhoosh() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;

      // Filtered noise swoosh
      const bufferSize = this.ctx.sampleRate * 0.2;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * 0.3;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(400, t);
      filter.frequency.exponentialRampToValueAtTime(1400, t + 0.1);
      filter.frequency.exponentialRampToValueAtTime(300, t + 0.2);
      filter.Q.value = 3.0;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.01, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);

      noise.start(t);
      noise.stop(t + 0.2);
    } catch {
      // Audio fallback
    }
  }

  public playDrawChime() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      notes.forEach((freq, idx) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t + idx * 0.04);
        gain.gain.setValueAtTime(0.12, t + idx * 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.04 + 0.25);
        osc.connect(gain);
        gain.connect(this.sfxGain!);
        osc.start(t + idx * 0.04);
        osc.stop(t + idx * 0.04 + 0.28);
      });
    } catch {
      // Audio fallback
    }
  }

  // Audio Ducking: lowers music when narrator is speaking
  public setDucking(active: boolean) {
    this.duckingActive = active;
    if (!this.ctx || !this.musicGain) return;
    const t = this.ctx.currentTime;
    const target = active ? MUSIC_DUCK_GAIN : MUSIC_BASE_GAIN;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.linearRampToValueAtTime(target, t + 0.25);
  }

  // Generative Background Music Tracks
  public startMusic(track: string = 'lofi') {
    this.initContext();
    // Always tear down any previous scheduler first so at most one music
    // loop exists, even when startMusic is called repeatedly.
    this.stopMusic();
    this.currentTrack = track;
    this.musicPlaying = true;

    // Re-apply the current ducking state to the (possibly freshly created)
    // gain node so toggling music off/on never accumulates volume changes.
    if (this.ctx && this.musicGain) {
      const t = this.ctx.currentTime;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(
        this.duckingActive ? MUSIC_DUCK_GAIN : MUSIC_BASE_GAIN,
        t
      );
    }

    // Generative chord progression based on track
    const chordProgressions: Record<string, number[][]> = {
      lofi: [
        [261.63, 329.63, 392.0, 493.88], // Cmaj7
        [220.0, 261.63, 329.63, 392.0], // Am7
        [174.61, 220.0, 261.63, 329.63], // Fmaj7
        [196.0, 246.94, 293.66, 349.23], // G7
      ],
      tech: [
        [130.81, 196.0, 261.63, 392.0], // C power
        [110.0, 164.81, 220.0, 329.63], // A power
        [146.83, 220.0, 293.66, 440.0], // D power
        [123.47, 185.0, 246.94, 370.0], // B power
      ],
      acoustic: [
        [261.63, 329.63, 392.0], // C
        [196.0, 246.94, 293.66], // G
        [220.0, 261.63, 329.63], // Am
        [174.61, 220.0, 261.63], // F
      ],
    };

    const chords = chordProgressions[track] || chordProgressions.lofi;
    let chordIdx = 0;

    const playChord = () => {
      if (!this.musicPlaying || !this.ctx || !this.musicGain) return;
      const notes = chords[chordIdx % chords.length];
      chordIdx++;

      const t = this.ctx.currentTime;
      notes.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = track === 'tech' ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(freq, t);

        const filter = this.ctx!.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(track === 'tech' ? 1200 : 700, t);

        gain.gain.setValueAtTime(0.02, t);
        gain.gain.linearRampToValueAtTime(0.08, t + 0.6 + i * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.005, t + 3.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.musicGain!);

        osc.start(t);
        osc.stop(t + 3.3);
      });
    };

    playChord();
    this.musicInterval = window.setInterval(playChord, 3200);
  }

  public stopMusic() {
    this.musicPlaying = false;
    if (this.musicInterval !== null) {
      clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }

  private clearFallbackTimer() {
    if (this.fallbackWordTimer !== null) {
      clearInterval(this.fallbackWordTimer);
      this.fallbackWordTimer = null;
    }
  }

  // Web Speech API Voiceover with Word Boundary Synchronization
  public speakNarration(
    text: string,
    onWordSpoken?: (word: string, charIndex: number, wordIndex: number) => void,
    onEnd?: () => void,
    rate: number = 1.0,
    pitch: number = 1.0,
    options: SpeakOptions = {}
  ): number {
    // Tear down any prior voice source first (this invalidates its session),
    // then open the new session, optionally adopting the coordinator's token.
    this.stopVoiceOnly();
    const sessionId = this.beginSession(options.sessionToken);
    this.setDucking(true);

    if (!('speechSynthesis' in window)) {
      this.setDucking(false);
      if (onEnd) onEnd();
      return sessionId;
    }

    if (!text || !text.trim()) {
      this.setDucking(false);
      if (onEnd) onEnd();
      return sessionId;
    }

    const trimmedText = text.trim();
    const wordsList = trimmedText.split(/\s+/).filter(Boolean);
    const startOffsetSec = Math.max(0, options.startOffsetSec || 0);
    const clampedRate = Math.max(0.7, Math.min(1.5, rate));
    const wordsPerSecond = WORDS_PER_SECOND_BASE * clampedRate;

    const utterance = new SpeechSynthesisUtterance(trimmedText);
    utterance.rate = clampedRate;
    utterance.pitch = Math.max(0.8, Math.min(1.3, pitch));

    // Try to pick a natural English voice
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice =
      voices.find(
        (v) =>
          (v.name.includes('Natural') ||
            v.name.includes('Google') ||
            v.name.includes('Siri') ||
            v.name.includes('Samantha') ||
            v.name.includes('Daniel')) &&
          v.lang.startsWith('en')
      ) || voices.find((v) => v.lang.startsWith('en'));

    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    this.hasReceivedNativeBoundary = false;

    // A word event belongs to the seek offset only once its estimated
    // position is at/past the offset. Earlier events belong to words the
    // playhead has already passed and must not move the highlight back.
    const isWithinOffset = (wordIndex: number) => wordIndex / wordsPerSecond >= startOffsetSec - 0.05;

    // Fallback timer: in case SpeechSynthesis onboundary is not fired by the OS/voice
    let fallbackIdx = 0;
    const intervalMs = Math.max(150, Math.round(1000 / wordsPerSecond));
    this.fallbackWordTimer = window.setInterval(() => {
      if (sessionId !== this.activeSessionId) {
        this.clearFallbackTimer();
        return;
      }
      if (this.hasReceivedNativeBoundary) {
        this.clearFallbackTimer();
        return;
      }
      if (fallbackIdx < wordsList.length) {
        const wordIndex = fallbackIdx;
        fallbackIdx++;
        if (!isWithinOffset(wordIndex)) return;
        const spokenWord = wordsList[wordIndex];
        if (onWordSpoken) {
          onWordSpoken(spokenWord, 0, wordIndex);
        }
        this.notifyWord(spokenWord, 0, wordIndex);
      }
    }, intervalMs);

    utterance.onboundary = (event) => {
      if (sessionId !== this.activeSessionId) return;
      if (event.name === 'word') {
        this.hasReceivedNativeBoundary = true;
        this.clearFallbackTimer();

        const charIdx = event.charIndex;
        const slice = trimmedText.slice(charIdx);
        const match = slice.match(/^[\w'-]+/);
        const spokenWord = match
          ? match[0]
          : event.charLength
          ? trimmedText.substring(charIdx, charIdx + event.charLength)
          : '';

        // Calculate 0-based word index
        const textBefore = trimmedText.slice(0, charIdx);
        const wordsBefore = textBefore.trim() ? textBefore.trim().split(/\s+/).filter(Boolean) : [];
        const wordIndex = wordsBefore.length;

        if (!isWithinOffset(wordIndex)) return;

        if (onWordSpoken) {
          onWordSpoken(spokenWord, charIdx, wordIndex);
        }
        this.notifyWord(spokenWord, charIdx, wordIndex);
      }
    };

    utterance.onend = () => {
      if (sessionId !== this.activeSessionId) return;
      this.clearFallbackTimer();
      this.setDucking(false);
      this.speechUtterance = null;
      this.notifyWord('', -1, -1);
      if (onEnd) onEnd();
    };

    utterance.onerror = () => {
      if (sessionId !== this.activeSessionId) return;
      this.clearFallbackTimer();
      this.setDucking(false);
      this.speechUtterance = null;
      this.notifyWord('', -1, -1);
      if (onEnd) onEnd();
    };

    this.speechUtterance = utterance;
    window.speechSynthesis.speak(utterance);
    return sessionId;
  }

  private customAudio: HTMLAudioElement | null = null;

  public playCustomAudio(url: string, onEnd?: () => void, sessionToken?: number): number {
    this.stopVoiceOnly();
    const sessionId = this.beginSession(sessionToken);
    this.setDucking(true);

    const audio = new Audio(url);
    this.customAudio = audio;

    audio.onended = () => {
      if (sessionId !== this.activeSessionId) return;
      this.setDucking(false);
      this.customAudio = null;
      this.notifyWord('', -1, -1);
      if (onEnd) onEnd();
    };
    audio.onerror = () => {
      if (sessionId !== this.activeSessionId) return;
      this.setDucking(false);
      this.customAudio = null;
      this.notifyWord('', -1, -1);
      if (onEnd) onEnd();
    };
    audio.play().catch(() => {});
    return sessionId;
  }

  /** Move a currently playing uploaded voice track to a new playhead time. */
  public seekCustomAudio(timeSec: number) {
    if (this.customAudio) {
      const clamped = Math.max(0, timeSec);
      try {
        this.customAudio.currentTime = Number.isFinite(clamped)
          ? Math.min(clamped, this.customAudio.duration || clamped)
          : 0;
      } catch {
        // Some media do not support seeking before metadata loads
      }
    }
  }

  public pauseCustomAudio() {
    if (this.customAudio) {
      this.customAudio.pause();
    }
  }

  public resumeCustomAudio() {
    if (this.customAudio) {
      this.customAudio.play().catch(() => {});
    }
  }

  public hasCustomAudio(): boolean {
    return this.customAudio !== null;
  }

  public stopCustomAudio() {
    if (this.customAudio) {
      const audio = this.customAudio;
      this.customAudio = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    this.setDucking(false);
    this.notifyWord('', -1, -1);
  }

  /** Stop voice sources without touching music playback. */
  private stopVoiceOnly() {
    this.clearFallbackTimer();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.speechUtterance = null;
    if (this.customAudio) {
      const audio = this.customAudio;
      this.customAudio = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    // Invalidate every pending callback from the previous source.
    this.activeSessionId += 1;
  }

  public stopSpeaking() {
    this.clearFallbackTimer();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.speechUtterance = null;
    if (this.customAudio) {
      const audio = this.customAudio;
      this.customAudio = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    this.activeSessionId += 1;
    this.notifyWord('', -1, -1);
    this.setDucking(false);
  }

  public stopAll() {
    this.stopSpeaking();
    this.stopMusic();
    this.notifyWord('', -1, -1);
  }
}

export const audioEngine = new AudioEngine();
