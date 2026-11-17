// Professional auto-mix engine.
//
// Per-deck Web Audio graph:
//   <audio> -> source -> low -> mid -> high (EQ) -> trim(gain) -> fader(gain) -> analyser -> out
//     low/mid/high : 3-band EQ for spectral-overlap-aware band swapping
//     trim         : per-track loudness normalization (from EBU R128 analysis)
//     fader        : selectable crossfader curve (power/smooth/cut)
//
// Transitions tempo-match (beatmatch) the incoming deck to the outgoing one using
// time-stretch at constant pitch (key preserved), start on a phrase boundary, and
// swap EQ bands to avoid clashes, then glide the new deck back to native tempo.

const CURVE_POINTS = 64;
// 3-band EQ corners.
const LOW_FREQ = 150;           // lowshelf  — kick/bass
const MID_FREQ = 1000;          // peaking   — body/vocals/leads
const HIGH_FREQ = 5000;         // highshelf — hats/air
const BASS_CUT_DB = -26;        // deep low cut on the incoming track (bass swap)
const MID_MAX_DB = 9;           // max mid cut, scaled by how much the mids clash
const HIGH_MAX_DB = 5;          // max high cut, scaled by clash
const TEMPO_TOLERANCE = 0.06;   // max ±6% time-stretch before we give up beatmatching
const RESYNC_SECONDS = 12;      // glide new deck back to native tempo over this long
const PLAYBACK_TARGET_LUFS = -14; // every track is trimmed toward this loudness
const MAX_BOOST_DB = 12;        // how far a quiet track may be raised (limiter catches peaks)
const MIN_AUTO_PLAY_FRACTION = 0.78; // automix will not start before this much has played

export class AutoDjPlayer {
  constructor({ onLog, onNowPlaying, onMeter, onProgress }) {
    this.context = null;
    this.decks = [];
    this.activeDeckIndex = 0;
    this.currentTrack = null;
    this.isTransitioning = false;
    this.monitorTimer = null;
    this.transitionTimer = null;
    this.manualTransition = false;
    this.manualLoading = false;
    this.manualNext = null;
    this.manualOrigin = 0;
    this.faderRaw = null;
    this.nudgeTimer = null;
    this.onLog = onLog;
    this.onNowPlaying = onNowPlaying;
    this.onMeter = onMeter;
    this.onProgress = onProgress;
    this.getNextTrack = null;
    this.crossfadeSeconds = 24;
    this.autoCrossfade = true;
    this.beatmatch = true;
    this.bassSwap = true;
    this.tempoTolerance = TEMPO_TOLERANCE;
    this.leveler = true;
    this.crossfadeCurve = "power";
    this.radioEditMode = true;
    this.noNextNoticeTrackId = null;
    this.heldDecks = new WeakMap();
    // Shared mix decision assembled by the frontend (scoreTransition). When set
    // for the upcoming pair, the player follows its entry/mix/duration/curve/EQ;
    // otherwise it falls back to its own per-track heuristics.
    this.plannedTransition = null;
  }

  async start(firstTrack, getNextTrack, crossfadeSeconds) {
    await this.ensureAudio();
    this.getNextTrack = getNextTrack;
    this.crossfadeSeconds = crossfadeSeconds;

    if (!this.currentTrack) {
      await this.playOnDeck(this.activeDeckIndex, firstTrack, firstTrack.analysis?.cueIn ?? 0, 1, 1);
      this.currentTrack = firstTrack;
      this.noNextNoticeTrackId = null;
      this.onNowPlaying?.(firstTrack);
      this.log(`Start: ${firstTrack.name}`);
    }

    this.startMonitor();
  }

  stop() {
    this.stopMonitor();
    if (this.transitionTimer) {
      window.clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    window.clearTimeout(this.nudgeTimer);
    this.manualTransition = false;
    this.manualLoading = false;
    this.manualNext = null;
    this.faderRaw = null;
    for (const deck of this.decks) {
      this.clearGlide(deck);
      deck.audio.pause();
      deck.audio.currentTime = 0;
      deck.audio.playbackRate = 1;
      deck.rate = 1;
      deck.gain.gain.cancelScheduledValues(this.context?.currentTime ?? 0);
      deck.gain.gain.value = 0;
      this.resetEq(deck, this.context?.currentTime ?? 0);
    }
    this.currentTrack = null;
    this.isTransitioning = false;
    this.onNowPlaying?.(null);
    this.log("Stop");
  }

  async skip() {
    if (!this.currentTrack || this.isTransitioning) return;
    await this.transitionNow();
  }

  setCrossfade(seconds) {
    this.crossfadeSeconds = seconds;
  }

  setCrossfadeCurve(curve) {
    this.crossfadeCurve = ["power", "smooth", "cut"].includes(curve) ? curve : "power";
  }

  setRadioEditMode(enabled) {
    this.radioEditMode = !!enabled;
  }

  setAutoCrossfade(enabled) {
    this.autoCrossfade = enabled;
  }

  setBeatmatch(enabled) {
    this.beatmatch = enabled;
  }

  setBassSwap(enabled) {
    this.bassSwap = enabled;
  }

  setTempoTolerance(value) {
    this.tempoTolerance = Math.max(0.005, value);
  }

  async ensureAudio() {
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }

    this.context = new AudioContext();

    // Master bus: deck mix -> masterGain -> limiter -> output. The limiter keeps
    // the global level constant and prevents clipping when two tracks overlap or
    // have different recording levels.
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 1;
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -10; // dB
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;      // limiter-like
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.limiter.connect(this.context.destination);
    this.masterGain.connect(this.leveler ? this.limiter : this.context.destination);

    this.decks = [this.createDeck("A"), this.createDeck("B")];
  }

  // Toggle the master leveler/limiter (bypass routes the mix straight to output).
  setLeveler(enabled) {
    this.leveler = enabled;
    if (!this.context) return;
    this.masterGain.disconnect();
    // limiter -> destination stays wired from setup; just route the mix through
    // the limiter (on) or straight to the output (bypass).
    this.masterGain.connect(enabled ? this.limiter : this.context.destination);
  }

  createDeck(name) {
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.preservesPitch = true; // time-stretch without shifting key

    const source = this.context.createMediaElementSource(audio);

    const lowEq = this.context.createBiquadFilter();
    lowEq.type = "lowshelf";
    lowEq.frequency.value = LOW_FREQ;
    lowEq.gain.value = 0;

    const midEq = this.context.createBiquadFilter();
    midEq.type = "peaking";
    midEq.frequency.value = MID_FREQ;
    midEq.Q.value = 0.7;
    midEq.gain.value = 0;

    const highEq = this.context.createBiquadFilter();
    highEq.type = "highshelf";
    highEq.frequency.value = HIGH_FREQ;
    highEq.gain.value = 0;

    const trim = this.context.createGain();
    trim.gain.value = 1;

    const gain = this.context.createGain();
    gain.gain.value = 0;

    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;

    source
      .connect(lowEq).connect(midEq).connect(highEq)
      .connect(trim).connect(gain).connect(analyser).connect(this.masterGain);

    const deck = {
      name,
      audio,
      eq: { low: lowEq, mid: midEq, high: highEq },
      trim,
      gain,
      analyser,
      rate: 1,
      glideTimer: null,
      meterData: new Uint8Array(analyser.frequencyBinCount)
    };

    audio.addEventListener("ended", () => this.handleDeckEnded(deck));
    audio.addEventListener("error", () => this.handleDeckError(deck));
    return deck;
  }

  handleDeckEnded(deck) {
    if (!this.currentTrack || deck !== this.decks[this.activeDeckIndex] || this.isTransitioning) return;
    const nextTrack = this.getNextTrack?.(this.currentTrack, { peek: true });
    if (nextTrack) {
      void this.transitionNow();
      return;
    }
    this.currentTrack = null;
    this.noNextNoticeTrackId = null;
    this.onNowPlaying?.(null);
    this.log("Fine riproduzione: nessun prossimo brano disponibile.");
  }

  handleDeckError(deck) {
    const code = deck.audio.error?.code;
    this.log(`Errore deck ${deck.name}${code ? ` (media code ${code})` : ""}.`);
    if (deck === this.decks[this.activeDeckIndex]) {
      this.isTransitioning = false;
      this.handleDeckEnded(deck);
    }
  }

  resetEq(deck, at) {
    for (const band of [deck.eq.low, deck.eq.mid, deck.eq.high]) {
      band.gain.cancelScheduledValues(at);
      band.gain.value = 0;
    }
  }

  // Per-track loudness trim toward PLAYBACK_TARGET_LUFS. Computed live from the
  // measured loudness so quiet tracks are actually brought up (the master limiter
  // protects against clipping). Falls back to the precomputed gain, then unity.
  computeTrim(analysis) {
    const lufs = analysis?.loudnessLufs;
    if (Number.isFinite(lufs)) {
      const db = clamp(PLAYBACK_TARGET_LUFS - lufs, -24, MAX_BOOST_DB);
      return clamp(Math.pow(10, db / 20), 0.2, 6);
    }
    return clamp(analysis?.gain ?? 1, 0.2, 6);
  }

  async playOnDeck(deckIndex, track, startAt, faderVolume, rate) {
    const deck = this.decks[deckIndex];
    deck.audio.pause();
    deck.audio.src = track.url;
    deck.audio.preservesPitch = true;
    deck.audio.playbackRate = rate;
    deck.rate = rate;
    deck.audio.currentTime = Math.max(0, Math.min(startAt, (track.analysis?.duration ?? 0) - 0.5));

    const now = this.context.currentTime;
    deck.trim.gain.cancelScheduledValues(now);
    deck.trim.gain.value = this.computeTrim(track.analysis);
    this.resetEq(deck, now);
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.value = faderVolume;

    await playWithTimeout(deck.audio, 8000);
  }

  startMonitor() {
    if (this.monitorTimer) return;

    this.monitorTimer = window.setInterval(() => {
      this.updateMeters();
      this.reportProgress();
      if (!this.currentTrack || this.isTransitioning) return;

      const deck = this.decks[this.activeDeckIndex];
      const analysis = this.currentTrack.analysis;
      if (!analysis) return;

      const duration = deck.audio.duration || analysis.duration || 0;
      const cueIn = analysis.cueIn ?? 0;
      const cueOut = analysis.cueOut || duration;
      const conservativeCueOut = duration
        ? Math.min(duration, Math.max(cueOut, cueIn + (duration - cueIn) * MIN_AUTO_PLAY_FRACTION))
        : cueOut;
      // Crossfade length is capped to the vocal-free outro so we never fade over vocals.
      const fade = this.transitionLength(this.currentTrack, null);
      // currentTime advances in real seconds; convert the fade lead-in by playback rate.
      const latest = Math.max(cueIn, conservativeCueOut - fade * deck.rate);
      // Where to begin the fade. Priority: shared plan mix point, then a user
      // mix point, then the outgoing track's last phrase boundary before `latest`.
      const nextPeek = this.getNextTrack?.(this.currentTrack, { peek: true });
      const planMix = this.planFor(nextPeek)?.fromMixPoint;
      const mixPoint = Number.isFinite(planMix) ? planMix : analysis.mixPoint;
      const transitionAt = this.radioEditMode && this.isUsableMixPoint(analysis, mixPoint, latest, duration)
        ? Math.max(cueIn, mixPoint)
        : this.phraseBoundaryBefore(analysis, latest);

      if (deck.audio.currentTime >= transitionAt) {
        this.transitionNow();
      }
    }, 160);
  }

  reportProgress() {
    if (!this.currentTrack) {
      this.onProgress?.(0, 0, null);
      return;
    }
    const deck = this.decks[this.activeDeckIndex];
    const duration = deck.audio.duration || this.currentTrack.analysis?.duration || 0;
    this.onProgress?.(deck.audio.currentTime || 0, duration, this.currentTrack, deck.name);
  }

  // Jump the playing deck to an absolute position (seconds).
  seek(seconds) {
    if (!this.currentTrack) return;
    const deck = this.decks[this.activeDeckIndex];
    const duration = deck.audio.duration || this.currentTrack.analysis?.duration || 0;
    if (!duration) return;
    deck.audio.currentTime = clamp(seconds, 0, duration - 0.05);
    this.reportProgress();
  }

  stopMonitor() {
    if (!this.monitorTimer) return;
    window.clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  clearGlide(deck) {
    if (!deck?.glideTimer) return;
    window.clearInterval(deck.glideTimer);
    deck.glideTimer = null;
  }

  // Step a deck's playback rate toward a target over `seconds` (HTMLMediaElement
  // playbackRate is not an AudioParam, so we ramp it with a timer).
  glideRate(deck, targetRate, seconds) {
    this.clearGlide(deck);
    const startRate = deck.rate;
    const steps = Math.max(1, Math.round((seconds * 1000) / 100));
    let step = 0;
    deck.glideTimer = window.setInterval(() => {
      step += 1;
      const t = step / steps;
      const rate = startRate + (targetRate - startRate) * t;
      deck.audio.playbackRate = rate;
      deck.rate = rate;
      if (step >= steps) {
        deck.audio.playbackRate = targetRate;
        deck.rate = targetRate;
        this.clearGlide(deck);
      }
    }, 100);
  }

  // Crossfade length, clamped so it fits inside both the outgoing vocal-free outro
  // and (when known) the incoming vocal-free intro. In auto mode the base length
  // adapts to the track; otherwise it is the user's fixed setting.
  transitionLength(fromTrack, toTrack) {
    // A shared plan's duration (radio-edit crossfade, independent from the club
    // crossfade slider) wins when present and we have an incoming track to match.
    const plan = toTrack ? this.planFor(toTrack) : null;
    let fade = Number.isFinite(plan?.durationSeconds)
      ? plan.durationSeconds
      : this.autoCrossfade
      ? this.autoFade(fromTrack, toTrack)
      : Math.max(2, this.crossfadeSeconds);
    const outro = fromTrack?.analysis?.mixableOutro;
    if (Number.isFinite(outro) && outro > 0) fade = Math.min(fade, outro);
    const intro = toTrack?.analysis?.mixableIntro;
    if (Number.isFinite(intro) && intro > 0) fade = Math.min(fade, intro);
    return Math.max(2, fade);
  }

  // Auto crossfade: a whole number of phrases/bars, chosen by energy, in seconds
  // at the outgoing track's effective tempo. Calm tracks blend long, hot tracks cut
  // short. The user's crossfade value acts as the upper cap.
  autoFade(fromTrack, toTrack) {
    const a = fromTrack?.analysis;
    if (!a?.bpm) return Math.max(2, this.crossfadeSeconds);
    const beatSec = 60 / (a.bpm * (this.decks[this.activeDeckIndex]?.rate || 1));
    const energyFrom = a.energy ?? 0.5;
    const energyTo = toTrack?.analysis?.energy ?? energyFrom;
    const energy = (energyFrom + energyTo) / 2;
    // 16 beats hot, 32 medium, 48 calm. This intentionally avoids rushed mixes.
    const beats = energy > 0.66 ? 16 : energy > 0.4 ? 32 : 48;
    const cap = this.crossfadeSeconds > 0 ? this.crossfadeSeconds : 32;
    return clamp(beats * beatSec, 8, Math.max(8, cap));
  }

  // Symmetric beatmatch: the two tracks meet at the geometric-mean tempo, each
  // bending half the (octave-folded) difference. Returns the outgoing deck's new
  // rate and the incoming deck's rate. Outside tolerance, neither is stretched.
  matchRatesSymmetric(fromTrack, toTrack) {
    const fromDeck = this.decks[this.activeDeckIndex];
    const noChange = { fromRate: fromDeck.rate, toRate: 1 };
    // The shared plan can explicitly disable beatmatch (e.g. far-apart BPMs).
    const plan = this.planFor(toTrack);
    if (plan && plan.beatmatch === false) return noChange;
    if (!this.beatmatch) return noChange;

    const fromBpm = fromTrack?.analysis?.bpm;
    const toBpm = toTrack?.analysis?.bpm;
    if (!fromBpm || !toBpm) return noChange;

    const fromEff = fromBpm * fromDeck.rate;
    let ratio = fromEff / toBpm; // total stretch the incoming would need to match
    while (ratio > 1.41) ratio /= 2;
    while (ratio < 0.71) ratio *= 2;
    if (Math.abs(ratio - 1) > this.tempoTolerance) return noChange;

    const half = Math.sqrt(ratio);
    return {
      fromRate: fromDeck.rate / half, // outgoing bends toward the meeting tempo
      toRate: half                    // incoming bends the other half
    };
  }

  // Latest phrase boundary at or before time `t` (falls back to the beat grid,
  // then to `t` itself when no grid is available).
  phraseBoundaryBefore(analysis, t) {
    const anchor = analysis?.phraseAnchor ?? analysis?.downbeat;
    const interval = analysis?.phraseInterval ?? analysis?.barInterval;
    const floor = analysis?.cueIn ?? 0;
    if (anchor == null || !interval) return t;
    const k = Math.floor((t - anchor) / interval);
    const boundary = anchor + k * interval;
    return boundary >= floor ? boundary : t;
  }

  isUsableMixPoint(analysis, point, latest, duration) {
    if (!Number.isFinite(point) || !analysis) return false;
    const cueIn = analysis.cueIn ?? 0;
    const cueOut = analysis.cueOut ?? duration ?? 0;
    const playable = Math.max(1, cueOut - cueIn);
    const earliest = cueIn + playable * 0.5;
    return point >= earliest && point <= latest + 0.5 && point < cueOut;
  }

  // Choose the incoming track's start so it begins on a phrase boundary near its
  // cue-in. Combined with tempo matching this keeps the two tracks phrase-locked.
  phraseAlignedStart(fromTrack, toTrack, startAt) {
    const to = toTrack?.analysis;
    const anchor = to?.phraseAnchor ?? to?.downbeat ?? to?.firstBeat;
    const interval = to?.phraseInterval ?? to?.barInterval ?? to?.beatInterval;
    if (anchor == null || !interval) return startAt;

    // Nearest phrase boundary to the cue-in, but never before it.
    const k = Math.max(0, Math.round((startAt - anchor) / interval));
    let aligned = anchor + k * interval;
    if (aligned < startAt) aligned += interval;
    // Don't skip more than one phrase past the cue-in.
    if (aligned - startAt > interval) aligned -= interval;
    return aligned >= 0 ? aligned : startAt;
  }

  // The shared plan, if it was assembled for this exact incoming track.
  planFor(nextTrack) {
    const plan = this.plannedTransition;
    if (!plan || !nextTrack?.analysis) return null;
    return plan;
  }

  // Entry point for an incoming track: the manual override if the user set one,
  // then the shared plannedTransition entry, then the phrase-aligned auto start.
  entryFor(nextTrack) {
    const manual = nextTrack.analysis?.entryPoint;
    const plan = this.planFor(nextTrack);
    if (this.radioEditMode && Number.isFinite(plan?.toEntryPoint)) return plan.toEntryPoint;
    if (this.radioEditMode && Number.isFinite(manual)) return manual;
    return this.phraseAlignedStart(this.currentTrack, nextTrack, nextTrack.analysis?.cueIn ?? 0);
  }

  async transitionNow() {
    const nextTrack = this.getNextTrack?.(this.currentTrack, { peek: true });
    if (!nextTrack) {
      if (this.noNextNoticeTrackId !== this.currentTrack?.id) {
        this.noNextNoticeTrackId = this.currentTrack?.id ?? null;
        this.log("Nessun prossimo brano disponibile, continuo fino al cue out.");
      }
      return;
    }

    this.noNextNoticeTrackId = null;
    this.isTransitioning = true;
    this.manualNext = nextTrack; // remembered so a manual takeover can finalize

    const fromIndex = this.activeDeckIndex;
    const toIndex = fromIndex === 0 ? 1 : 0;
    const fromDeck = this.decks[fromIndex];
    const toDeck = this.decks[toIndex];
    const duration = this.transitionLength(this.currentTrack, nextTrack);
    const now = this.context.currentTime;

    // Symmetric beatmatch: incoming starts at its meeting rate; outgoing bends
    // toward the same meeting tempo across its outro (the crossfade window).
    this.clearGlide(fromDeck);
    this.clearGlide(toDeck);
    const { fromRate, toRate } = this.matchRatesSymmetric(this.currentTrack, nextTrack);
    const startAt = this.entryFor(nextTrack);

    try {
      await this.playOnDeck(toIndex, nextTrack, startAt, 0, toRate);
      this.getNextTrack?.(this.currentTrack, { commitId: nextTrack.id });
    } catch (error) {
      this.clearGlide(fromDeck);
      this.clearGlide(toDeck);
      toDeck.audio.pause();
      toDeck.audio.src = "";
      toDeck.rate = 1;
      this.resetEq(toDeck, now);
      toDeck.gain.gain.cancelScheduledValues(now);
      toDeck.gain.gain.value = 0;
      this.isTransitioning = false;
      this.manualNext = null;
      this.log(`Mix annullato: ${nextTrack.name} non parte (${error?.message ?? error})`);
      return;
    }

    if (Math.abs(fromRate - fromDeck.rate) > 0.0005) {
      this.glideRate(fromDeck, fromRate, duration);
    }

    // Selectable crossfader curve. The shared plan may override it (e.g. "cut"
    // when both tracks have vocals); otherwise use the user's setting. "power"
    // is the DJ default for avoiding the perceived centre dip.
    const plan = this.planFor(nextTrack);
    const curve = ["power", "smooth", "cut"].includes(plan?.curve) ? plan.curve : this.crossfadeCurve;
    const fadeOut = new Float32Array(CURVE_POINTS);
    const fadeIn = new Float32Array(CURVE_POINTS);
    const startGain = fromDeck.gain.gain.value;
    for (let i = 0; i < CURVE_POINTS; i += 1) {
      const x = i / (CURVE_POINTS - 1);
      const [outGain, inGain] = crossfadeGains(x, curve);
      fadeOut[i] = outGain * startGain;
      fadeIn[i] = inGain;
    }
    fromDeck.gain.gain.cancelScheduledValues(now);
    toDeck.gain.gain.cancelScheduledValues(now);
    fromDeck.gain.gain.setValueCurveAtTime(fadeOut, now, duration);
    toDeck.gain.gain.setValueCurveAtTime(fadeIn, now, duration);

    // 3-band EQ swap, driven by how much each band of the two tracks overlaps.
    // Low band always swaps (two basslines must never coexist); mid/high are cut
    // on the incoming track in proportion to the spectral clash, then restored.
    if (this.bassSwap) {
      const clash = this.bandClash(this.currentTrack, nextTrack);
      const midCut = -MID_MAX_DB * clash.mid;
      const highCut = -HIGH_MAX_DB * clash.high;

      // Low: deep swap.
      toDeck.eq.low.gain.cancelScheduledValues(now);
      toDeck.eq.low.gain.setValueAtTime(BASS_CUT_DB, now);
      toDeck.eq.low.gain.setValueAtTime(BASS_CUT_DB, now + duration * 0.45);
      toDeck.eq.low.gain.linearRampToValueAtTime(0, now + duration);
      fromDeck.eq.low.gain.cancelScheduledValues(now);
      fromDeck.eq.low.gain.setValueAtTime(0, now);
      fromDeck.eq.low.gain.linearRampToValueAtTime(BASS_CUT_DB, now + duration * 0.55);

      // Mid: duck the incoming mids while the outgoing lead/vocal is still present.
      if (midCut < -0.5) {
        toDeck.eq.mid.gain.cancelScheduledValues(now);
        toDeck.eq.mid.gain.setValueAtTime(midCut, now);
        toDeck.eq.mid.gain.setValueAtTime(midCut, now + duration * 0.4);
        toDeck.eq.mid.gain.linearRampToValueAtTime(0, now + duration);
      }

      // High: gentle early dip on the incoming highs to avoid harsh hat clash.
      if (highCut < -0.5) {
        toDeck.eq.high.gain.cancelScheduledValues(now);
        toDeck.eq.high.gain.setValueAtTime(highCut, now);
        toDeck.eq.high.gain.linearRampToValueAtTime(0, now + duration * 0.6);
      }
    }

    const rateNote = toRate !== 1 ? ` | beatmatch ×${toRate.toFixed(3)}` : "";
    this.log(`Mix: ${this.currentTrack.name} -> ${nextTrack.name} (${duration.toFixed(1)}s${rateNote})`);

    this.transitionTimer = window.setTimeout(() => {
      this.transitionTimer = null;
      this.finalizeTransition(fromIndex, toIndex, nextTrack);
    }, duration * 1000);
  }

  // Swap decks once a transition (auto or manual) reaches the incoming track.
  finalizeTransition(fromIndex, toIndex, nextTrack) {
    const fromDeck = this.decks[fromIndex];
    const toDeck = this.decks[toIndex];
    this.clearGlide(fromDeck);
    fromDeck.audio.pause();
    fromDeck.audio.currentTime = 0;
    fromDeck.audio.playbackRate = 1;
    fromDeck.rate = 1;
    this.resetEq(fromDeck, this.context.currentTime);
    toDeck.gain.gain.cancelScheduledValues(this.context.currentTime);
    toDeck.gain.gain.value = 1;
    this.activeDeckIndex = toIndex;
    this.currentTrack = nextTrack;
    this.isTransitioning = false;
    this.manualTransition = false;
    this.manualLoading = false;
    this.onNowPlaying?.(nextTrack);
    // Body of the track plays native: ease the new deck from its meeting rate
    // back to 1.0 over the resync window.
    if (Math.abs(toDeck.rate - 1) > 0.0005) this.glideRate(toDeck, 1, RESYNC_SECONDS);
  }

  // === Live manual control from a hardware controller (overrides auto on touch) ===

  // Crossfader: ride the blend by hand. The fader auto-orients — push it from
  // wherever it rests toward the far end to bring in the next track.
  setManualCrossfade(raw) {
    if (!this.context || !this.currentTrack || this.manualLoading) return;
    const pos = clamp(raw, 0, 1);

    // First message just registers the resting position; no action.
    if (this.faderRaw === null) {
      this.faderRaw = pos;
      return;
    }
    const moved = pos - this.faderRaw;
    this.faderRaw = pos;
    if (Math.abs(moved) < 0.004) return;

    const fromIndex = this.activeDeckIndex;
    const toIndex = fromIndex === 0 ? 1 : 0;

    // Take over an automatic transition that is already running.
    if (this.isTransitioning && !this.manualTransition) {
      if (this.transitionTimer) {
        window.clearTimeout(this.transitionTimer);
        this.transitionTimer = null;
      }
      this.clearGlide(this.decks[fromIndex]);
      this.manualTransition = true;
      this.manualOrigin = pos - moved;
    }

    // Or start a fresh manual transition into the next track.
    if (!this.isTransitioning && !this.manualTransition) {
      const nextTrack = this.getNextTrack?.(this.currentTrack, { peek: true });
      if (!nextTrack) return;
      this.manualOrigin = pos - moved;
      void this.beginManualTransition(nextTrack, toIndex);
      return;
    }

    if (!this.manualTransition) return;

    // Blend = how far the fader has travelled from where the mix started.
    const span = Math.max(0.05, this.manualOrigin, 1 - this.manualOrigin);
    const blend = clamp(Math.abs(pos - this.manualOrigin) / span, 0, 1);

    const fromDeck = this.decks[fromIndex];
    const toDeck = this.decks[toIndex];
    const now = this.context.currentTime;
    fromDeck.gain.gain.cancelScheduledValues(now);
    toDeck.gain.gain.cancelScheduledValues(now);
    const [outGain, inGain] = crossfadeGains(blend, this.crossfadeCurve);
    fromDeck.gain.gain.value = outGain;
    toDeck.gain.gain.value = inGain;

    if (blend >= 0.98) {
      this.finalizeTransition(fromIndex, toIndex, this.manualNext);
      this.manualNext = null;
    }
  }

  async beginManualTransition(nextTrack, toIndex) {
    this.manualLoading = true;
    this.isTransitioning = true;
    this.manualNext = nextTrack;
    const { toRate } = this.matchRatesSymmetric(this.currentTrack, nextTrack);
    const startAt = this.entryFor(nextTrack);
    try {
      await this.playOnDeck(toIndex, nextTrack, startAt, 0, toRate);
      this.getNextTrack?.(this.currentTrack, { commitId: nextTrack.id });
      this.manualTransition = true;
      this.log(`Mix manuale: ${this.currentTrack.name} -> ${nextTrack.name}`);
    } catch (error) {
      const deck = this.decks[toIndex];
      const now = this.context.currentTime;
      deck.audio.pause();
      deck.audio.src = "";
      deck.rate = 1;
      this.resetEq(deck, now);
      deck.gain.gain.cancelScheduledValues(now);
      deck.gain.gain.value = 0;
      this.isTransitioning = false;
      this.manualNext = null;
      this.log(`Mix manuale annullato: ${nextTrack.name} non parte (${error?.message ?? error})`);
    } finally {
      this.manualLoading = false;
    }
  }

  // EQ knobs drive the active deck's bands live (−26..+6 dB, centre = 0).
  setManualEq(band, db) {
    if (!this.context) return;
    const node = this.decks[this.activeDeckIndex].eq[band];
    if (!node) return;
    node.gain.cancelScheduledValues(this.context.currentTime);
    node.gain.value = clamp(db, -26, 6);
  }

  // Jog: a brief tempo bump on the active deck to nudge beats into phase.
  nudge(amount) {
    if (!this.context || !this.currentTrack) return;
    const deck = this.decks[this.activeDeckIndex];
    deck.audio.playbackRate = deck.rate * (1 + amount);
    window.clearTimeout(this.nudgeTimer);
    this.nudgeTimer = window.setTimeout(() => {
      deck.audio.playbackRate = deck.rate;
    }, 150);
  }

  setDisplayDeckHold(displayDeck, held) {
    if (!this.context || !this.decks.length) return false;
    const deck = this.displayDeck(displayDeck);
    if (!deck || !deck.audio.src) return false;

    if (held) {
      if (this.heldDecks.get(deck)) return true;
      this.heldDecks.set(deck, { wasPlaying: !deck.audio.paused });
      if (!deck.audio.paused) deck.audio.pause();
      return true;
    }

    const hold = this.heldDecks.get(deck);
    if (!hold) return false;
    this.heldDecks.delete(deck);
    if (hold.wasPlaying) {
      playWithTimeout(deck.audio, 3000).catch((error) => this.log(`Hold release non riuscito: ${error?.message ?? error}`));
    }
    return true;
  }

  scratchDisplayDeck(displayDeck, deltaSeconds) {
    const deck = this.displayDeck(displayDeck);
    if (!deck || !deck.audio.src || !Number.isFinite(deltaSeconds)) return false;
    const duration = deck.audio.duration || 0;
    if (!duration) return false;
    deck.audio.currentTime = clamp(deck.audio.currentTime + deltaSeconds, 0, Math.max(0, duration - 0.05));
    if (displayDeck === "A" && this.currentTrack) this.reportProgress();
    return true;
  }

  displayDeck(displayDeck) {
    if (!this.decks.length) return null;
    const active = this.activeDeckIndex;
    if (displayDeck === "A") return this.decks[active];
    return this.decks[active === 0 ? 1 : 0];
  }

  // Per-band clash intensity (0..1) between two tracks: the geometric mean of
  // their normalized energy in each band. Falls back to "low only" without data.
  bandClash(fromTrack, toTrack) {
    const a = fromTrack?.analysis?.bandEnergy;
    const b = toTrack?.analysis?.bandEnergy;
    if (!a || !b) return { low: 1, mid: 0, high: 0 };
    return {
      low: Math.sqrt((a.low ?? 0) * (b.low ?? 0)),
      mid: Math.sqrt((a.mid ?? 0) * (b.mid ?? 0)),
      high: Math.sqrt((a.high ?? 0) * (b.high ?? 0))
    };
  }

  updateMeters() {
    for (const deck of this.decks) {
      deck.analyser.getByteFrequencyData(deck.meterData);
      const avg = deck.meterData.reduce((sum, value) => sum + value, 0) / Math.max(1, deck.meterData.length);
      const level = avg / 255;
      // Approximate dBFS for a numeric readout (-inf..0).
      const db = level > 0 ? 20 * Math.log10(level) : -Infinity;
      this.onMeter?.(deck.name, level, db);
    }
  }

  log(message) {
    this.onLog?.(message);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

async function playWithTimeout(audio, timeoutMs) {
  const playPromise = audio.play();
  if (!playPromise?.then) return;

  let timeoutId = null;
  try {
    await Promise.race([
      playPromise,
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error("audio.play() timeout: il browser non ha avviato il media"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function crossfadeGains(value, curve) {
  const x = clamp(value, 0, 1);
  if (curve === "smooth") {
    const smooth = smoothstep(x);
    return [1 - smooth, smooth];
  }
  if (curve === "cut") {
    const cut = Math.pow(x, 0.28);
    const out = Math.pow(1 - x, 0.28);
    return [out, cut];
  }
  // Equal-power curve: both decks are around -3 dB at centre, avoiding the
  // audible hole created by linear/constant-sum crossfades on unrelated audio.
  return [
    Math.cos((x * Math.PI) / 2),
    Math.sin((x * Math.PI) / 2)
  ];
}

function mod(value, m) {
  return ((value % m) + m) % m;
}
