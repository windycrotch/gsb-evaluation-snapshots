/// Clamp an `f32` parameter into `[min, max]`.
///
/// Returns `None` for any non-finite value (NaN, +infinity, -infinity) so
/// illegal parameters are rejected outright instead of poisoning the DSP
/// state. Finite values outside the legal range are clamped to the nearest
/// boundary (so out-of-range inputs degrade gracefully rather than erroring
/// on the audio thread).
pub fn sanitize_f32(value: f32, min: f32, max: f32) -> Option<f32> {
    if !value.is_finite() {
        return None;
    }
    Some(value.clamp(min, max))
}

/// Clamp an integer parameter into `[min, max]`.
///
/// Floating point values that survive the JS/WASM boundary are rounded
/// before clamping; NaN and infinities are rejected.
pub fn sanitize_usize(value: f32, min: usize, max: usize) -> Option<usize> {
    if !value.is_finite() {
        return None;
    }
    let rounded = value.round();
    if rounded < min as f32 {
        return Some(min);
    }
    if rounded > max as f32 {
        return Some(max);
    }
    Some(rounded as usize)
}

pub struct SimpleRng {
    state: u64,
}

impl SimpleRng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn random(&mut self) -> f32 {
        // Simple LCG constants
        self.state = self.state.wrapping_mul(1103515245).wrapping_add(12345);
        // Convert to float between -1 and 1
        let normalized = (self.state as f32) / (u64::MAX as f32);
        normalized * 2.0 - 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_f32_rejects_non_finite_values() {
        assert_eq!(sanitize_f32(f32::NAN, 0.0, 1.0), None);
        assert_eq!(sanitize_f32(f32::INFINITY, 0.0, 1.0), None);
        assert_eq!(sanitize_f32(f32::NEG_INFINITY, 0.0, 1.0), None);
    }

    #[test]
    fn sanitize_f32_clamps_out_of_range_values() {
        assert_eq!(sanitize_f32(-5.0, 0.0, 1.0), Some(0.0));
        assert_eq!(sanitize_f32(5.0, 0.0, 1.0), Some(1.0));
        assert_eq!(sanitize_f32(0.5, 0.0, 1.0), Some(0.5));
    }

    #[test]
    fn sanitize_usize_rejects_non_finite_values() {
        assert_eq!(sanitize_usize(f32::NAN, 1, 16), None);
        assert_eq!(sanitize_usize(f32::INFINITY, 1, 16), None);
        assert_eq!(sanitize_usize(f32::NEG_INFINITY, 1, 16), None);
    }

    #[test]
    fn sanitize_usize_rounds_and_clamps() {
        assert_eq!(sanitize_usize(3.4, 1, 16), Some(3));
        assert_eq!(sanitize_usize(3.6, 1, 16), Some(4));
        assert_eq!(sanitize_usize(-10.0, 1, 16), Some(1));
        assert_eq!(sanitize_usize(100.0, 1, 16), Some(16));
        assert_eq!(sanitize_usize(8.0, 1, 16), Some(8));
    }
}
