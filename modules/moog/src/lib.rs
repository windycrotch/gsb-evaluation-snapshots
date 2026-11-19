use shared::sanitize_f32;
use wasm_bindgen::prelude::*;

/// Legal range for the `cutoff` parameter (normalized frequency).
pub const MIN_CUTOFF: f32 = 0.0;
pub const MAX_CUTOFF: f32 = 1.0;

/// Legal range for the `resonance` parameter.
pub const MIN_RESONANCE: f32 = 0.0;
pub const MAX_RESONANCE: f32 = 4.0;

#[wasm_bindgen]
pub struct MoogModule {
    cutoff: f32,
    resonance: f32,

    // Input and output
    in1: f32,
    in2: f32,
    in3: f32,
    in4: f32,
    out1: f32,
    out2: f32,
    out3: f32,
    out4: f32,
}

#[wasm_bindgen]
impl MoogModule {
    pub fn new(cutoff: f32, resonance: f32) -> MoogModule {
        MoogModule {
            cutoff: sanitize_f32(cutoff, MIN_CUTOFF, MAX_CUTOFF).unwrap_or(0.065),
            resonance: sanitize_f32(resonance, MIN_RESONANCE, MAX_RESONANCE)
                .unwrap_or(3.5),
            in1: 0.0,
            in2: 0.0,
            in3: 0.0,
            in4: 0.0,
            out1: 0.0,
            out2: 0.0,
            out3: 0.0,
            out4: 0.0,
        }
    }

    /// Update the cutoff at runtime.
    ///
    /// Returns `true` when the value was accepted (after clamping) and
    /// `false` when it was rejected (NaN / infinity), leaving the module
    /// untouched.
    pub fn set_cutoff(&mut self, cutoff: f32) -> bool {
        match sanitize_f32(cutoff, MIN_CUTOFF, MAX_CUTOFF) {
            Some(sanitized) => {
                self.cutoff = sanitized;
                true
            }
            None => false,
        }
    }

    /// Update the resonance at runtime.
    ///
    /// Returns `true` when the value was accepted (after clamping) and
    /// `false` when it was rejected (NaN / infinity), leaving the module
    /// untouched.
    pub fn set_resonance(&mut self, resonance: f32) -> bool {
        match sanitize_f32(resonance, MIN_RESONANCE, MAX_RESONANCE) {
            Some(sanitized) => {
                self.resonance = sanitized;
                true
            }
            None => false,
        }
    }

    pub fn process(&mut self, samples: &js_sys::Float32Array) -> js_sys::Float32Array {
        let samples_vec: Vec<f32> = samples.to_vec();
        let output = self.process_vec(samples_vec);
        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, mut samples: Vec<f32>) -> Vec<f32> {
        let f = (self.cutoff * 1.16).clamp(0.0, 0.99);
        let input_factor = 0.35013 * (f * f) * (f * f);
        let fb = (self.resonance * (1.0 - 0.15 * f * f)).clamp(0.0, 0.95);

        // Loop over samples and apply moog filter
        for sample in samples.iter_mut() {
            let mut base = *sample;

            // A non-finite input must never propagate into the filter state.
            if !base.is_finite() {
                base = 0.0;
            }

            base -= self.out4 * fb;
            base *= input_factor;

            // Pole 1
            self.out1 = base + 0.3 * self.in1 + (1.0 - f) * self.out1;
            self.in1 = base;

            // Pole 2
            self.out2 = self.out1 + 0.3 * self.in2 + (1.0 - f) * self.out2;
            self.in2 = self.out1;

            // Pole 3
            self.out3 = self.out2 + 0.3 * self.in3 + (1.0 - f) * self.out3;
            self.in3 = self.out2;

            // Pole 4
            self.out4 = self.out3 + 0.3 * self.in4 + (1.0 - f) * self.out4;
            self.in4 = self.out3;

            // Final safety net: the audio thread must never emit a
            // non-finite sample, even if internal state drifted.
            let output = self.out4.clamp(-1.0, 1.0);
            *sample = if output.is_finite() { output } else { 0.0 };
        }

        samples
    }
}
