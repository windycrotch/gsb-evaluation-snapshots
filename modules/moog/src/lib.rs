use wasm_bindgen::prelude::*;

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
            cutoff: MoogModule::sanitize_cutoff(cutoff),
            resonance: MoogModule::sanitize_resonance(resonance),
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
            // A NaN/Inf input would be multiplied into the feedback path and
            // poison all four pole states permanently; sanitize per sample.
            let input = if sample.is_finite() { *sample } else { 0.0 };

            let mut base = input;
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

            // Defense in depth: if any pole ever became non-finite
            // (e.g. extreme parameter ramp), reset the ladder instead of
            // emitting NaN/Inf and locking the node into a broken state.
            if !self.out1.is_finite()
                || !self.out2.is_finite()
                || !self.out3.is_finite()
                || !self.out4.is_finite()
            {
                self.in1 = 0.0;
                self.in2 = 0.0;
                self.in3 = 0.0;
                self.in4 = 0.0;
                self.out1 = 0.0;
                self.out2 = 0.0;
                self.out3 = 0.0;
                self.out4 = 0.0;
            }

            *sample = self.out4.clamp(-1.0, 1.0);
        }

        samples
    }

    /// In-place parameter update. The four-pole state (in1..out4) is kept so
    /// parameter changes cross-fade through the existing signal instead of
    /// resetting the filter, which would cause an audible click.
    pub fn set_cutoff(&mut self, cutoff: f32) {
        self.cutoff = MoogModule::sanitize_cutoff(cutoff);
    }

    pub fn set_resonance(&mut self, resonance: f32) {
        self.resonance = MoogModule::sanitize_resonance(resonance);
    }

    fn sanitize_cutoff(cutoff: f32) -> f32 {
        if cutoff.is_finite() {
            cutoff.clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    fn sanitize_resonance(resonance: f32) -> f32 {
        if resonance.is_finite() {
            resonance.clamp(0.0, 10.0)
        } else {
            0.0
        }
    }
}
