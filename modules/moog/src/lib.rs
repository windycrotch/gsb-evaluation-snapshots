use wasm_bindgen::prelude::*;

/// Default cutoff used when the constructor receives an illegal value.
pub const DEFAULT_CUTOFF: f32 = 0.065;
/// Default resonance used when the constructor receives an illegal value.
pub const DEFAULT_RESONANCE: f32 = 3.5;
/// Highest value the cutoff is allowed to take (inclusive).
pub const MAX_CUTOFF: f32 = 1.0;
/// Highest value the resonance is allowed to take (inclusive).
pub const MAX_RESONANCE: f32 = 20.0;

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

fn is_valid_cutoff(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_CUTOFF as f64).contains(&value)
}

fn is_valid_resonance(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_RESONANCE as f64).contains(&value)
}

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
        let cutoff = if is_valid_cutoff(cutoff as f64) {
            cutoff
        } else {
            DEFAULT_CUTOFF
        };
        let resonance = if is_valid_resonance(resonance as f64) {
            resonance
        } else {
            DEFAULT_RESONANCE
        };

        MoogModule {
            cutoff,
            resonance,
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

    /// Update the cutoff of the live module.
    ///
    /// Returns `true` when accepted. The four pole state is preserved so the
    /// filter keeps running without a click.
    #[wasm_bindgen(js_name = setCutoff)]
    pub fn set_cutoff_js(&mut self, cutoff: f64) -> bool {
        self.try_set_cutoff(cutoff).is_ok()
    }

    /// Update the resonance of the live module.
    ///
    /// Returns `true` when accepted. The four pole state is preserved so the
    /// filter keeps running without a click.
    #[wasm_bindgen(js_name = setResonance)]
    pub fn set_resonance_js(&mut self, resonance: f64) -> bool {
        self.try_set_resonance(resonance).is_ok()
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
            base -= self.out4 * fb;
            base *= input_factor;

            // Stabilize the ladder if a previous state ever became non-finite
            // (e.g. a hostile input). This keeps the module producing sound.
            if !self.state_is_finite() || !base.is_finite() {
                self.reset_state();
                base = 0.0;
            }

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

            *sample = self.out4.clamp(-1.0, 1.0);
        }

        samples
    }
}

impl MoogModule {
    /// Current cutoff.
    pub fn cutoff(&self) -> f32 {
        self.cutoff
    }

    /// Current resonance.
    pub fn resonance(&self) -> f32 {
        self.resonance
    }

    /// Validate and apply a new cutoff while keeping the filter state intact.
    pub fn try_set_cutoff(&mut self, cutoff: f64) -> Result<(), InvalidParameter> {
        if !is_valid_cutoff(cutoff) {
            return Err(InvalidParameter::new(
                "cutoff",
                cutoff,
                "cutoff must be a finite number between 0 and 1",
            ));
        }

        self.cutoff = cutoff as f32;
        Ok(())
    }

    /// Validate and apply a new resonance while keeping the filter state intact.
    pub fn try_set_resonance(&mut self, resonance: f64) -> Result<(), InvalidParameter> {
        if !is_valid_resonance(resonance) {
            return Err(InvalidParameter::new(
                "resonance",
                resonance,
                "resonance must be a finite number between 0 and 20",
            ));
        }

        self.resonance = resonance as f32;
        Ok(())
    }

    fn state_is_finite(&self) -> bool {
        self.in1.is_finite()
            && self.in2.is_finite()
            && self.in3.is_finite()
            && self.in4.is_finite()
            && self.out1.is_finite()
            && self.out2.is_finite()
            && self.out3.is_finite()
            && self.out4.is_finite()
    }

    fn reset_state(&mut self) {
        self.in1 = 0.0;
        self.in2 = 0.0;
        self.in3 = 0.0;
        self.in4 = 0.0;
        self.out1 = 0.0;
        self.out2 = 0.0;
        self.out3 = 0.0;
        self.out4 = 0.0;
    }
}
