use wasm_bindgen::prelude::*;
// use web_sys::{console};

#[wasm_bindgen]
pub struct BitcrusherModule {
    bits: usize,
    phaser: f32,
    last: f32,
}

#[wasm_bindgen]
impl BitcrusherModule {
    pub fn new(bits: usize) -> BitcrusherModule {
        BitcrusherModule {
            bits: BitcrusherModule::sanitize_bits(bits),
            phaser: 0.0,
            last: 0.0,
        }
    }

    pub fn process(&mut self, samples: &js_sys::Float32Array, normfreq: f32) -> js_sys::Float32Array {

        // console::log_1(&"Processing in Rust".into());

        let samples_vec: Vec<f32> = samples.to_vec();

        let output = self.process_vec(samples_vec, normfreq);

        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, samples: Vec<f32>, normfreq: f32) -> Vec<f32> {
        let mut output = samples;

        let step = 0.5_f32.powf(self.bits as f32);

        // A non-finite normfreq would make the phaser run away to NaN and
        // silence the node forever - fall back to "hold current sample".
        let normfreq = if normfreq.is_finite() {
            normfreq
        } else {
            0.0
        };

        // Loop over samples and apply bitcrusher effect
        for sample in output.iter_mut() {
            // Guard against NaN/Inf input so a single bad upstream sample
            // can't poison the held value and every following block.
            if !sample.is_finite() {
                *sample = self.last;
                continue;
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

    /// In-place reconfiguration. Keeps the continuous-time state (phaser and
    /// held sample) so changing bit depth mid-stream does not click.
    pub fn set_bits(&mut self, bits: usize) {
        self.bits = BitcrusherModule::sanitize_bits(bits);
    }

    /// Copy the signal-continuity state from another module. Used after a
    /// rebuild so a freshly constructed module takes over without a jump.
    pub fn adopt_state_from(&mut self, other: &BitcrusherModule) {
        if other.phaser.is_finite() && other.last.is_finite() {
            self.phaser = other.phaser.clamp(0.0, 1.0);
            self.last = other.last;
        }
    }

    fn sanitize_bits(bits: usize) -> usize {
        // usize can't be NaN/negative, but absurdly large values make
        // `0.5.powf(bits)` underflow to zero and divide by zero.
        bits.clamp(1, 32)
    }
}

// Don't forget to add this for panic handling
// #[wasm_bindgen(start)]
// pub fn main() {
//     console_error_panic_hook::set_once();
// }
