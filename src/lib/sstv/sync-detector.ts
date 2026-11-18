/**
 * SSTV Sync Pulse Detector
 * Detects 1200Hz sync pulses of various durations (5ms, 9ms, 20ms)
 * Based on xdsopl/robot36 Demodulator.java
 */

import {
  Complex,
  Phasor,
  FrequencyModulation,
  SimpleMovingAverage,
  SchmittTrigger,
  Delay,
  ComplexConvolution,
} from './fm-demodulator';

export enum SyncPulseWidth {
  FiveMilliSeconds,
  NineMilliSeconds,
  TwentyMilliSeconds,
  None,
}

/** A single sync pulse that ended inside the chunk just processed. */
export interface SyncPulseEvent {
  width: SyncPulseWidth;
  /**
   * Sample offset, relative to the START of the samples passed to the current
   * `process()` call, where the sync pulse ended (delay compensated).
   *
   * The value always addresses a sample inside the current call (`0 <= offset
   * < samples.length`). When a pulse spans more than one `process()` call the
   * pulse-end transition is observed in the call that receives the trailing
   * part of the pulse, so the reported position is in that chunk. Callers
   * translate it to an absolute buffer position with
   * `chunkStart + offset` (modulo the buffer size).
   */
  offset: number;
  frequencyOffset: number;
}

export interface SyncPulseDetection extends SyncPulseEvent {
  detected: boolean;
  /**
   * Every valid sync pulse detected during this call, in the order they ended.
   * The top-level fields mirror the last entry so that simple callers can keep
   * using the single-result shape.
   */
  detections: SyncPulseEvent[];
}

export class SyncDetector {
  private syncPulseFilter: SimpleMovingAverage;
  private baseBandLowPass: ComplexConvolution;
  private frequencyModulation: FrequencyModulation;
  private syncPulseTrigger: SchmittTrigger;
  private baseBandOscillator: Phasor;
  private syncPulseValueDelay: Delay;

  // Width measurement state. This counter is deliberately a field (not a local
  // of process()) so that a pulse straddling two process() calls keeps
  // accumulating instead of being restarted at each chunk boundary.
  private syncPulseCounter: number = 0;
  private centerFrequency: number;
  private scanLineBandwidth: number;
  private syncPulseFrequencyValue: number;
  private syncPulseFrequencyTolerance: number;

  private syncPulse5msMinSamples: number;
  private syncPulse5msMaxSamples: number;
  private syncPulse9msMaxSamples: number;
  private syncPulse20msMaxSamples: number;
  private syncPulseFilterDelay: number;

  // Debug counters
  private debugSampleCount: number = 0;
  private debugLastLogTime: number = 0;
  private debugMaxCounter: number = 0;

  public static readonly SYNC_PULSE_FREQ = 1200;
  public static readonly BLACK_FREQ = 1500;
  public static readonly WHITE_FREQ = 2300;

  constructor(sampleRate: number) {
    // Use the same approach as Java: bandwidth is black-to-white range
    this.scanLineBandwidth = SyncDetector.WHITE_FREQ - SyncDetector.BLACK_FREQ;  // 800Hz
    this.frequencyModulation = new FrequencyModulation(this.scanLineBandwidth, sampleRate);

    // Sync pulse timing
    const syncPulse5msSeconds = 0.005;
    const syncPulse9msSeconds = 0.009;
    const syncPulse20msSeconds = 0.020;

    // Min/max bounds for pulse width detection
    const syncPulse5msMinSeconds = syncPulse5msSeconds / 2;
    const syncPulse5msMaxSeconds = (syncPulse5msSeconds + syncPulse9msSeconds) / 2;
    const syncPulse9msMaxSeconds = (syncPulse9msSeconds + syncPulse20msSeconds) / 2;
    const syncPulse20msMaxSeconds = syncPulse20msSeconds + syncPulse5msSeconds;

    this.syncPulse5msMinSamples = Math.round(syncPulse5msMinSeconds * sampleRate);
    this.syncPulse5msMaxSamples = Math.round(syncPulse5msMaxSeconds * sampleRate);
    this.syncPulse9msMaxSamples = Math.round(syncPulse9msMaxSeconds * sampleRate);
    this.syncPulse20msMaxSamples = Math.round(syncPulse20msMaxSeconds * sampleRate);

    // Sync pulse filter
    const syncPulseFilterSeconds = syncPulse5msSeconds / 2;
    const syncPulseFilterSamples = Math.round(syncPulseFilterSeconds * sampleRate) | 1;
    this.syncPulseFilterDelay = (syncPulseFilterSamples - 1) / 2;
    this.syncPulseFilter = new SimpleMovingAverage(syncPulseFilterSamples);
    this.syncPulseValueDelay = new Delay(syncPulseFilterSamples);

    // Baseband conversion - same as Java
    const lowestFrequency = 1000;   // 1000Hz (below sync)
    const highestFrequency = 2800;  // 2800Hz (above white)
    const cutoffFrequency = (highestFrequency - lowestFrequency) / 2;
    const baseBandLowPassSeconds = 0.002;
    const baseBandLowPassSamples = Math.round(baseBandLowPassSeconds * sampleRate) | 1;
    this.baseBandLowPass = ComplexConvolution.createLowPassFilter(baseBandLowPassSamples, cutoffFrequency, sampleRate);
    this.centerFrequency = (lowestFrequency + highestFrequency) / 2;  // 1900Hz
    this.baseBandOscillator = new Phasor(-this.centerFrequency, sampleRate);

    // Sync pulse detection thresholds
    this.syncPulseFrequencyValue = this.normalizeFrequency(SyncDetector.SYNC_PULSE_FREQ);
    this.syncPulseFrequencyTolerance = (50 * 2) / this.scanLineBandwidth;

    const syncPorchFrequency = 1500;
    const syncHighFrequency = (SyncDetector.SYNC_PULSE_FREQ + syncPorchFrequency) / 2;
    const syncLowFrequency = (SyncDetector.SYNC_PULSE_FREQ + syncHighFrequency) / 2;
    const syncLowValue = this.normalizeFrequency(syncLowFrequency);
    const syncHighValue = this.normalizeFrequency(syncHighFrequency);

    this.syncPulseTrigger = new SchmittTrigger(syncLowValue, syncHighValue);

    // Log configuration for debugging
    console.log(`🔧 SyncDetector initialized:`);
    console.log(`   Center freq: ${this.centerFrequency}Hz, Bandwidth: ${this.scanLineBandwidth}Hz`);
    console.log(`   Sync freq: ${SyncDetector.SYNC_PULSE_FREQ}Hz → normalized: ${this.syncPulseFrequencyValue.toFixed(3)}`);
    console.log(`   Schmitt trigger: low=${syncLowValue.toFixed(3)} (${syncLowFrequency}Hz), high=${syncHighValue.toFixed(3)} (${syncHighFrequency}Hz)`);
    console.log(`   Pulse width samples: 5ms=${this.syncPulse5msMinSamples}-${this.syncPulse5msMaxSamples}, 9ms=${this.syncPulse5msMaxSamples}-${this.syncPulse9msMaxSamples}, 20ms=${this.syncPulse9msMaxSamples}-${this.syncPulse20msMaxSamples}`);
    console.log(`   Freq tolerance: ${this.syncPulseFrequencyTolerance.toFixed(3)}`);
  }

  private normalizeFrequency(frequency: number): number {
    return ((frequency - this.centerFrequency) * 2) / this.scanLineBandwidth;
  }

  /**
   * Keep the reported pulse-end offset addressable inside the chunk that is
   * currently being processed. A filter-delay correction can push the position
   * before sample 0 when the pulse started in an earlier chunk.
   */
  private clampOffsetToChunk(offset: number, chunkLength: number): number {
    if (chunkLength <= 0) return 0;
    if (offset < 0) return 0;
    if (offset > chunkLength - 1) return chunkLength - 1;
    return offset;
  }

  /**
   * Process audio samples and detect sync pulses
   * @param samples Input audio samples
   * @param demodulated Output buffer for demodulated frequency values
   * @returns Sync pulse detection result
   */
  process(samples: Float32Array, demodulated: Float32Array): SyncPulseDetection {
    let syncPulseDetected = false;
    let syncPulseWidth = SyncPulseWidth.None;
    let syncPulseOffset = 0;
    let frequencyOffset = 0;
    const detections: SyncPulseEvent[] = [];

    this.debugSampleCount += samples.length;

    // Number of samples the detection path lags behind the true pulse edge.
    // Used to map the observed trigger release back to the pulse end.
    const pulseEndDelay = this.syncPulseFilterDelay;

    // Track demodulated value statistics
    let minDemod = Infinity;
    let maxDemod = -Infinity;
    let sumDemod = 0;

    for (let i = 0; i < samples.length; i++) {
      // Convert to complex baseband (shift center frequency to 0)
      let baseBand = new Complex(samples[i], 0).mul(this.baseBandOscillator.rotate());

      // Apply lowpass filter to baseband signal
      baseBand = this.baseBandLowPass.push(baseBand);

      // FM demodulation
      const frequencyValue = this.frequencyModulation.demod(baseBand);

      // Filter for sync detection (matches Robot36 implementation)
      const syncPulseValue = this.syncPulseFilter.avg(frequencyValue);
      const syncPulseDelayedValue = this.syncPulseValueDelay.push(syncPulseValue);

      // Store UNcompensated value for line decoder
      // Line decoder expects normalized frequency values (±1.0 range) to convert to pixel levels
      demodulated[i] = frequencyValue;

      // Track demodulated value statistics
      minDemod = Math.min(minDemod, syncPulseValue);
      maxDemod = Math.max(maxDemod, syncPulseValue);
      sumDemod += syncPulseValue;

      // Track max counter for debugging
      if (this.syncPulseCounter > this.debugMaxCounter) {
        this.debugMaxCounter = this.syncPulseCounter;
      }

      // Sync pulse detection using Schmitt trigger.
      // `syncPulseCounter` lives on the instance, so a pulse that straddles two
      // process() calls keeps accumulating across the chunk boundary instead of
      // being restarted (which would mis-measure or miss the pulse).
      if (!this.syncPulseTrigger.latch(syncPulseValue)) {
        // In sync pulse (low frequency)
        this.syncPulseCounter++;
      } else if (
        this.syncPulseCounter < this.syncPulse5msMinSamples ||
        this.syncPulseCounter > this.syncPulse20msMaxSamples ||
        Math.abs(syncPulseDelayedValue - this.syncPulseFrequencyValue) > this.syncPulseFrequencyTolerance
      ) {
        // Invalid sync pulse - log why
        if (this.syncPulseCounter > 0) {
          const now = Date.now();
          if (now - this.debugLastLogTime > 1000) {  // Log every 1 second instead of 5
            const reason =
              this.syncPulseCounter < this.syncPulse5msMinSamples ? 'too short' :
              this.syncPulseCounter > this.syncPulse20msMaxSamples ? 'too long' :
              'freq mismatch';
            console.log(`❌ Rejected pulse: ${reason}, counter=${this.syncPulseCounter} (need ${this.syncPulse5msMinSamples}-${this.syncPulse20msMaxSamples}), freqDiff=${Math.abs(syncPulseDelayedValue - this.syncPulseFrequencyValue).toFixed(3)} (tol=${this.syncPulseFrequencyTolerance.toFixed(3)})`);
            console.log(`   syncPulseValue=${syncPulseValue.toFixed(3)}, delayed=${syncPulseDelayedValue.toFixed(3)}, target=${this.syncPulseFrequencyValue.toFixed(3)}`);
            this.debugLastLogTime = now;
          }
        }
        this.syncPulseCounter = 0;
      } else {
        // Valid sync pulse detected!
        if (this.syncPulseCounter < this.syncPulse5msMaxSamples) {
          syncPulseWidth = SyncPulseWidth.FiveMilliSeconds;
        } else if (this.syncPulseCounter < this.syncPulse9msMaxSamples) {
          syncPulseWidth = SyncPulseWidth.NineMilliSeconds;
        } else {
          syncPulseWidth = SyncPulseWidth.TwentyMilliSeconds;
        }

        // Map the observed (filter-delayed) release point back to the true pulse
        // end. For a pulse that started in a previous call the compensated
        // position can fall before this chunk; the result is clamped so the
        // returned offset always addresses a sample inside the current call.
        // Callers convert it with `chunkStart + offset`.
        syncPulseOffset = this.clampOffsetToChunk(i - pulseEndDelay, samples.length);
        frequencyOffset = syncPulseDelayedValue - this.syncPulseFrequencyValue;
        syncPulseDetected = true;
        console.log(`✅ Valid sync detected: width=${syncPulseWidth}, counter=${this.syncPulseCounter}, freqOffset=${frequencyOffset.toFixed(3)}`);
        detections.push({
          width: syncPulseWidth,
          offset: syncPulseOffset,
          frequencyOffset,
        });
        this.syncPulseCounter = 0;
        this.debugMaxCounter = 0;
      }
    }

    // Periodic debug logging
    const now = Date.now();
    if (now - this.debugLastLogTime > 3000 && !syncPulseDetected) {
      // Track COMPENSATED values (raw after compensation), not filtered EMA values
      let minCompensated = Infinity;
      let maxCompensated = -Infinity;
      let sumCompensated = 0;
      for (let i = 0; i < demodulated.length; i++) {
        minCompensated = Math.min(minCompensated, demodulated[i]);
        maxCompensated = Math.max(maxCompensated, demodulated[i]);
        sumCompensated += demodulated[i];
      }
      const avgCompensated = sumCompensated / demodulated.length;
      const avgFiltered = sumDemod / samples.length;

      console.log(`🔍 SyncDetector: ${this.debugSampleCount} samples, maxCounter=${this.debugMaxCounter}`);
      console.log(`   RAW compensated: min=${minCompensated.toFixed(3)}, max=${maxCompensated.toFixed(3)}, avg=${avgCompensated.toFixed(3)}`);
      console.log(`   Filtered (EMA): min=${minDemod.toFixed(3)}, max=${maxDemod.toFixed(3)}, avg=${avgFiltered.toFixed(3)}`);
      console.log(`   Target sync: ${this.syncPulseFrequencyValue.toFixed(3)} ± ${this.syncPulseFrequencyTolerance.toFixed(3)}`);
      console.log(`   Schmitt thresholds: low=-1.563, high=-1.375 (trigger on sync pulse)`);
      this.debugLastLogTime = now;
      this.debugMaxCounter = 0;
    }

    return {
      detected: syncPulseDetected,
      width: syncPulseWidth,
      offset: syncPulseOffset,
      frequencyOffset,
      detections,
    };
  }

  reset(): void {
    // Everything that carries state from one process() call (and therefore
    // from one audio buffer) to the next must be cleared here.
    this.syncPulseFilter.reset();
    this.frequencyModulation.reset();
    this.syncPulseTrigger.reset();
    this.syncPulseValueDelay.reset();
    this.baseBandLowPass.reset();
    this.baseBandOscillator.reset();
    this.syncPulseCounter = 0;
    this.debugSampleCount = 0;
    this.debugLastLogTime = 0;
    this.debugMaxCounter = 0;
  }
}
