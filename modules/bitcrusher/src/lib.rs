use wasm_bindgen::prelude::*;
// use web_sys::{console};

/// Lowest legal bit depth. A value of zero would divide by a zero step size.
pub const MIN_BITS: u32 = 1;
/// Highest legal bit depth (32). Keeps the step size representable in `f32`.
pub const MAX_BITS: u32 = 32;
/// Bit depth used by the constructor when it receives an illegal value.
pub const DEFAULT_BITS: u32 = 4;

/// Describes a parameter update that was rejected.
#[derive(Debug, Clone, PartialEq)]
pub struct InvalidParameter {
    pub parameter: &'static str,
    pub value: f64,
    pub reason: &'static str,
}

impl InvalidParameter {
    fn new(parameter: &'static str, value: f64, reason: &'static str) -> Self {
        InvalidParameter {
            parameter,
            value,
            reason,
        }
    }
}

fn is_integral(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

#[wasm_bindgen]
pub struct BitcrusherModule {
    bits: u32,
    phaser: f32,
    last: f32,
}

#[wasm_bindgen]
impl BitcrusherModule {
    pub fn new(bits: usize) -> BitcrusherModule {
        let bits = if (MIN_BITS as usize..=MAX_BITS as usize).contains(&bits) {
            bits as u32
        } else {
            DEFAULT_BITS
        };

        BitcrusherModule {
            bits,
            phaser: 0.0,
            last: 0.0,
        }
    }

    /// Update the bit depth of the live module.
    ///
    /// Returns `true` when the value was accepted. Rejected values leave the
    /// previous bit depth (and therefore the current audio) untouched.
    #[wasm_bindgen(js_name = setBits)]
    pub fn set_bits_js(&mut self, bits: f64) -> bool {
        self.try_set_bits(bits).is_ok()
    }

    pub fn process(
        &mut self,
        samples: &js_sys::Float32Array,
        normfreq: f32,
    ) -> js_sys::Float32Array {
        // console::log_1(&"Processing in Rust".into());

        let samples_vec: Vec<f32> = samples.to_vec();

        let output = self.process_vec(samples_vec, normfreq);

        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, samples: Vec<f32>, normfreq: f32) -> Vec<f32> {
        let mut output = samples;

        // Guard against non-finite / out of range sample rate modifiers so a
        // bad value from JS can never poison the running phaser.
        let normfreq = if normfreq.is_finite() {
            normfreq.clamp(0.0, 1.0)
        } else {
            0.0
        };

        let step = 0.5_f32.powf(self.bits as f32);

        // Loop over samples and apply bitcrusher effect
        for sample in output.iter_mut() {
            self.phaser += normfreq;
            if self.phaser >= 1.0 {
                self.phaser -= 1.0;
                self.last = step * (*sample / step + 0.5).floor();
            }

            // Never let a non-finite held sample leak into the output graph.
            if !self.last.is_finite() {
                self.last = 0.0;
            }

            *sample = self.last;
        }

        output
    }
}

impl BitcrusherModule {
    /// Current bit depth.
    pub fn bits(&self) -> usize {
        self.bits as usize
    }

    /// Validate and apply a new bit depth without disturbing the phaser or the
    /// last held sample, so playback stays continuous across the change.
    pub fn try_set_bits(&mut self, bits: f64) -> Result<(), InvalidParameter> {
        if !bits.is_finite() {
            return Err(InvalidParameter::new(
                "bits",
                bits,
                "bits must be a finite number",
            ));
        }

        if !is_integral(bits) {
            return Err(InvalidParameter::new(
                "bits",
                bits,
                "bits must be a whole number",
            ));
        }

        if bits < MIN_BITS as f64 || bits > MAX_BITS as f64 {
            return Err(InvalidParameter::new(
                "bits",
                bits,
                "bits must be between 1 and 32",
            ));
        }

        self.bits = bits as u32;
        Ok(())
    }
}

// Don't forget to add this for panic handling
// #[wasm_bindgen(start)]
// pub fn main() {
//     console_error_panic_hook::set_once();
// }
