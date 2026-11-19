// PlaybackCoordinator: the single owner of the playhead.
//
// It drives one requestAnimationFrame clock and forwards every state change
// to the UI through explicit callbacks:
//   onTime(time)              -> progress bar + canvas redraw
//   onWordIndex(idx, source)  -> subtitle highlight
//   onSceneEnd() / onRequestNextScene()
//
// Voice (Web Speech TTS) and uploaded audio are treated as "voice sessions"
// keyed by monotonic tokens. Any token that is no longer active is ignored,
// so callbacks from a scene that was left behind (or a replaced audio track)
// can never affect the current scene's subtitles.
//
// The class intentionally has no React or DOM rendering dependency beyond
// requestAnimationFrame (injected with a fallback) so it can be unit tested.

import {
  clampToSceneTime,
  effectiveTriggerTime,
  estimateWordIndex,
  isSceneEndReached,
  resolveSubtitleState,
  SessionTokenSource,
  splitNarrationWords,
  SubtitleState,
} from './playbackSync';

export type VoiceKind = 'tts' | 'custom' | 'none';

export interface CoordinatorScene {
  id: string;
  narration: string;
  durationSeconds: number;
  customAudioUrl?: string;
}

export interface CoordinatorCallbacks {
  onTime: (time: number) => void;
  onSubtitle: (state: SubtitleState) => void;
  onPlayingChange: (playing: boolean) => void;
  onRequestNextScene: () => void;
  onSceneEnd: () => void;
}

export interface CoordinatorAudioPort {
  startTts: (
    text: string,
    onWord: (wordIndex: number) => void,
    onEnd: () => void,
    rate: number,
    pitch: number,
    startOffsetSec: number,
    sessionToken: number
  ) => number;
  startCustomAudio: (url: string, onEnd: () => void, sessionToken: number) => number;
  seekCustomAudio: (timeSec: number) => void;
  pauseCustomAudio: () => void;
  resumeCustomAudio: () => void;
  stopVoice: () => void;
  setDucking: (active: boolean) => void;
}

export interface CoordinatorConfig {
  audio: CoordinatorAudioPort;
  callbacks: CoordinatorCallbacks;
  raf?: (cb: (ts: number) => void) => number;
  cancelRaf?: (id: number) => void;
  /** Optional clock override for tests. */
  now?: () => number;
}

export class PlaybackCoordinator {
  private readonly audio: CoordinatorAudioPort;
  private readonly callbacks: CoordinatorCallbacks;
  private readonly raf: (cb: (ts: number) => void) => number;
  private readonly cancelRaf: (id: number) => void;
  private readonly now: () => number;
  private readonly tokens = new SessionTokenSource();

  private scene: CoordinatorScene;
  private isLastScene = false;
  private playing = false;
  private time = 0;
  private speed = 1;
  private rafId: number | null = null;
  private lastTs: number | null = null;

  // Voice / subtitle session state
  private voiceToken = -1;
  private voiceKind: VoiceKind = 'none';
  private voiceMuted = false;
  private rate = 1;
  private pitch = 1;

  // Callback-driven word index. Invalidated on every play / seek / scene change.
  private callbackWordIndex = -1;
  private callbackValid = false;
  // Word frozen at the moment playback is paused, so the subtitle stays on
  // the current spoken word instead of jumping to a re-estimated position.
  private heldWordIndex = -1;

  constructor(scene: CoordinatorScene, config: CoordinatorConfig, isLastScene: boolean = false) {
    this.scene = scene;
    this.isLastScene = isLastScene;
    this.audio = config.audio;
    this.callbacks = config.callbacks;
    this.raf =
      config.raf ||
      ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(this.now()), 16) as unknown as number)));
    this.cancelRaf =
      config.cancelRaf ||
      ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id as unknown as NodeJS.Timeout)));
    this.now = config.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.time = 0;
  }

  // ---- Queries -----------------------------------------------------------

  public getTime(): number {
    return this.time;
  }

  public isPlaying(): boolean {
    return this.playing;
  }

  public getVoiceKind(): VoiceKind {
    return this.voiceKind;
  }

  public getSubtitleState(): SubtitleState {
    // While paused, freeze on the word that was highlighted at pause time.
    if (!this.playing && this.heldWordIndex >= 0) {
      return { wordIndex: this.heldWordIndex, fromCallback: false };
    }
    return resolveSubtitleState({
      narration: this.scene.narration,
      currentTime: this.time,
      duration: this.scene.durationSeconds,
      isPlaying: this.playing,
      callbackWordIndex: this.callbackWordIndex,
      callbackValid: this.callbackValid,
    });
  }

  // ---- Scene / config ----------------------------------------------------

  /**
   * Switch to another scene. Any in-flight voice/audio is stopped, tokens
   * are invalidated, the playhead resets to zero and playback (if active)
   * restarts with the new scene's voice source.
   */
  public setScene(scene: CoordinatorScene, isLastScene: boolean, playing: boolean) {
    this.invalidateVoice();
    this.scene = scene;
    this.isLastScene = isLastScene;
    this.time = 0;
    this.lastTs = null;
    this.heldWordIndex = -1;
    this.resetCallbackState();
    this.callbacks.onTime(0);
    this.callbacks.onSubtitle(this.getSubtitleState());

    this.playing = playing;
    this.callbacks.onPlayingChange(playing);
    if (playing) {
      this.startVoiceSession();
      this.startClock();
    } else {
      this.stopClock();
    }
  }

  public setLastScene(isLastScene: boolean) {
    this.isLastScene = isLastScene;
  }

  /**
   * Update the current scene's editable data (narration / audio url /
   * duration) without resetting the playhead. Used when the user edits the
   * script while paused; if playback is active the voice is restarted by the
   * caller via updateVoiceSource().
   */
  public syncSceneData(scene: CoordinatorScene) {
    this.scene = scene;
  }

  public setSpeed(speed: number) {
    this.speed = speed;
    // Restarting the clock baseline prevents a delta jump on the next frame.
    this.lastTs = null;
  }

  public setVoiceSettings(rate: number, pitch: number) {
    this.rate = rate;
    this.pitch = pitch;
  }

  public setVoiceMuted(muted: boolean) {
    this.voiceMuted = muted;
    if (muted) {
      this.invalidateVoice();
      this.audio.setDucking(false);
    } else if (this.playing) {
      this.startVoiceSession();
    }
  }

  /** The scene's voice source changed (upload added / removed / replaced). */
  public updateVoiceSource() {
    if (this.playing) {
      this.startVoiceSession();
    }
  }

  // ---- Transport ---------------------------------------------------------

  public play() {
    if (this.playing) return;
    // Restart from the beginning if the previous run reached the end.
    if (isSceneEndReached(this.time, this.scene.durationSeconds)) {
      this.time = 0;
      this.callbacks.onTime(0);
    }
    this.playing = true;
    this.callbacks.onPlayingChange(true);
    this.heldWordIndex = -1;
    this.resetCallbackState();
    if (!this.voiceMuted) {
      this.startVoiceSession();
    } else {
      this.audio.setDucking(false);
    }
    this.startClock();
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  public pause() {
    if (!this.playing) return;
    // Capture the currently highlighted word before tearing down the voice
    // session so the subtitle can hold on it while paused.
    this.heldWordIndex = this.getSubtitleState().wordIndex;
    this.playing = false;
    this.callbacks.onPlayingChange(false);
    this.stopClock();
    // Stop every voice source immediately so nothing talks over the paused
    // state; resume restarts from the current playhead.
    this.invalidateVoice();
    this.audio.setDucking(false);
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  public togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jump to an explicit playhead position while staying in the same scene. */
  public seek(newTime: number) {
    const target = clampToSceneTime(newTime, this.scene.durationSeconds);
    this.time = target;
    this.lastTs = null;
    this.heldWordIndex = -1;
    this.resetCallbackState();
    this.callbacks.onTime(target);

    if (this.playing) {
      // Re-anchor the voice to the new playhead. Any previous session is
      // stopped inside startVoiceSession and its tokens are invalidated.
      if (!this.voiceMuted) {
        this.startVoiceSession(target);
      }
    } else {
      this.audio.setDucking(false);
    }
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  /** Rewind to scene start. Keeps current play/pause state. */
  public rewind() {
    this.seek(0);
  }

  /** Fully stop playback (e.g. app teardown). Music is left to the UI layer. */
  public destroy() {
    this.stopClock();
    this.invalidateVoice();
    this.audio.setDucking(false);
  }

  // ---- Internals ---------------------------------------------------------

  private startClock() {
    this.stopClock();
    this.lastTs = null;
    const tick = (ts: number) => {
      if (!this.playing) return;
      if (this.lastTs === null) this.lastTs = ts;
      const delta = Math.max(0, (ts - this.lastTs) / 1000);
      this.lastTs = ts;

      const next = this.time + delta * this.speed;
      if (isSceneEndReached(next, this.scene.durationSeconds)) {
        this.time = this.scene.durationSeconds;
        this.callbacks.onTime(this.time);
        this.handleSceneEnd();
        return;
      }
      this.time = next;
      this.callbacks.onTime(next);
      this.callbacks.onSubtitle(this.getSubtitleState());
      this.rafId = this.raf(tick);
    };
    this.rafId = this.raf(tick);
  }

  private stopClock() {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId);
      this.rafId = null;
    }
    this.lastTs = null;
  }

  private handleSceneEnd() {
    this.playing = false;
    this.callbacks.onPlayingChange(false);
    this.stopClock();
    this.invalidateVoice();
    this.audio.setDucking(false);
    if (this.isLastScene) {
      this.callbacks.onSceneEnd();
    } else {
      this.callbacks.onRequestNextScene();
    }
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  private resetCallbackState() {
    this.callbackWordIndex = -1;
    this.callbackValid = false;
  }

  /** Stop and invalidate whatever voice source is active. */
  private invalidateVoice() {
    this.voiceToken = -1;
    this.voiceKind = 'none';
    this.audio.stopVoice();
    this.resetCallbackState();
  }

  private resolveVoiceKind(): VoiceKind {
    if (this.voiceMuted) return 'none';
    if (this.scene.customAudioUrl) return 'custom';
    if (this.scene.narration && this.scene.narration.trim()) return 'tts';
    return 'none';
  }

  /**
   * Start (or restart after seek/resume) the voice session for the current
   * scene. Always invalidates prior sessions first so audio never overlaps.
   */
  private startVoiceSession(offsetSec: number = this.time) {
    this.invalidateVoice();
    const kind = this.resolveVoiceKind();
    this.voiceKind = kind;
    if (kind === 'none') {
      this.audio.setDucking(false);
      return;
    }

    this.audio.setDucking(true);
    const token = this.tokens.next();
    this.voiceToken = token;
    // The audio port self-guards its own callbacks with its internal
    // session id; the coordinator token guards against coordinator-side
    // restarts. Keeping the two checks independent avoids divergence when
    // the audio engine is also driven directly (e.g. the script "Listen"
    // preview) outside of this coordinator.
    const isTokenLive = () => this.voiceToken === token;

    if (kind === 'custom') {
      this.audio.startCustomAudio(
        this.scene.customAudioUrl as string,
        () => {
          if (!isTokenLive()) return;
          this.onVoiceEnded(token);
        },
        token
      );
      if (offsetSec > 0) {
        this.audio.seekCustomAudio(offsetSec);
      }
    } else {
      this.audio.startTts(
        this.scene.narration,
        (wordIndex) => {
          if (!isTokenLive()) return;
          this.acceptCallbackWord(wordIndex);
        },
        () => {
          if (!isTokenLive()) return;
          this.onVoiceEnded(token);
        },
        this.rate,
        this.pitch,
        offsetSec,
        token
      );
    }
  }

  private acceptCallbackWord(wordIndex: number) {
    const words = splitNarrationWords(this.scene.narration);
    if (wordIndex < 0 || wordIndex >= words.length) return;
    this.callbackWordIndex = wordIndex;
    this.callbackValid = true;
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  private onVoiceEnded(token: number) {
    if (this.voiceToken !== token) return;
    this.voiceKind = 'none';
    this.voiceToken = -1;
    this.resetCallbackState();
    // Ducking is restored by the audio port; just refresh subtitle state.
    this.callbacks.onSubtitle(this.getSubtitleState());
  }

  /**
   * Word index used for rendering, applying the "callback wins, otherwise
   * estimate from playhead" rule. Exposed for tests and UI consumers.
   */
  public getActiveWordIndex(): number {
    return this.getSubtitleState().wordIndex;
  }

  /** Estimated word index from the current playhead (no callback input). */
  public getEstimatedWordIndex(): number {
    return estimateWordIndex(this.scene.narration, this.time, this.scene.durationSeconds);
  }

  /** Effective (clamped) trigger time for an element of this scene. */
  public getEffectiveTriggerTime(triggerTimeSec: number | undefined): number {
    return effectiveTriggerTime(triggerTimeSec, this.scene.durationSeconds);
  }
}
