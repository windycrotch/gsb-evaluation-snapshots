use shared::{sanitize_f32, sanitize_usize};
use wasm_bindgen::prelude::*;
// use web_sys::{console};

/// Legal range for the bit depth (`bits`) parameter.
pub const MIN_BITS: usize = 1;
pub const MAX_BITS: usize = 16;

/// Legal range for the normalized sample/hold frequency (`normfreq`).
pub const MIN_NORMFREQ: f32 = 0.0;
pub const MAX_NORMFREQ: f32 = 1.0;

/// Default normalized frequency used when none is supplied at construction.
pub const DEFAULT_NORMFREQ: f32 = 0.1;

#[wasm_bindgen]
pub struct BitcrusherModule {
    bits: usize,
    normfreq: f32,
    phaser: f32,
    last: f32,
}

#[wasm_bindgen]
impl BitcrusherModule {
    pub fn new(bits: usize) -> BitcrusherModule {
        let bits = bits.clamp(MIN_BITS, MAX_BITS);
        BitcrusherModule {
            bits,
            normfreq: DEFAULT_NORMFREQ,
            phaser: 0.0,
            last: 0.0,
        }
    }

    /// Update the bit depth at runtime.
    ///
    /// Returns `true` when the value was accepted (after clamping) and
    /// `false` when it was rejected (NaN / infinity), leaving the module
    /// untouched.
    pub fn set_bits(&mut self, bits: f32) -> bool {
        match sanitize_usize(bits, MIN_BITS, MAX_BITS) {
            Some(sanitized) => {
                self.bits = sanitized;
                true
            }
            None => false,
        }
    }

    /// Update the normalized sample/hold frequency at runtime.
    ///
    /// Returns `true` when the value was accepted (after clamping) and
    /// `false` when it was rejected (NaN / infinity), leaving the module
    /// untouched.
    pub fn set_normfreq(&mut self, normfreq: f32) -> bool {
        match sanitize_f32(normfreq, MIN_NORMFREQ, MAX_NORMFREQ) {
            Some(sanitized) => {
                self.normfreq = sanitized;
                true
            }
            None => false,
        }
    }

    pub fn process(&mut self, samples: &js_sys::Float32Array) -> js_sys::Float32Array {
        // console::log_1(&"Processing in Rust".into());

        let samples_vec: Vec<f32> = samples.to_vec();

        // Use the live parameter stored on the module so `set_normfreq`
        // calls take effect immediately.
        let output = self.process_vec(samples_vec, self.normfreq);

        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, samples: Vec<f32>, normfreq: f32) -> Vec<f32> {
        // Never run the DSP with a non-finite frequency: fall back to the
        // last known-good value instead of producing NaN samples.
        let normfreq =
            sanitize_f32(normfreq, MIN_NORMFREQ, MAX_NORMFREQ).unwrap_or(self.normfreq);

        let mut output = samples;

        let step = 0.5_f32.powf(self.bits as f32);

        // Loop over samples and apply bitcrusher effect
        for sample in output.iter_mut() {
            // A non-finite input must never leak into the held state.
            if !sample.is_finite() {
                *sample = 0.0;
            }

            self.phaser += normfreq;
            if self.phaser >= 1.0 {
                self.phaser -= 1.0;
                self.last = step * (*sample / step + 0.5).floor();
            }
            *sample = self.last;
        }

        output
    }
}

// Don't forget to add this for panic handling
// #[wasm_bindgen(start)]
// pub fn main() {
//     console_error_panic_hook::set_once();
// }
