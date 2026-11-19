use clawdio_moog::{
    MoogModule, MAX_CUTOFF, MAX_RESONANCE, MIN_CUTOFF, MIN_RESONANCE,
};
use test_helpers::{generate_silence_samples, signal::generate_sine_wave, plotting::plot_waveform_comparison};

#[test]
fn test_silence_input() {
    let mut filter = MoogModule::new(0.5, 0.5);
    // Generate silence samples
    let silence = generate_silence_samples();

    // Run the filter process
    let result = filter.process_vec(silence);

    // Output should be close to zero for zero input
    for sample in result {
        assert!(sample.abs() < 0.001, "Sample too large: {}", sample);
    }
}

#[test]
fn test_impulse_response() {
    let mut filter = MoogModule::new(0.5, 0.1);
    // Generate a single impulse sample
    let mut impulse = vec![0.0; 128];
    impulse[0] = 1.0;

    let output = filter.process_vec(impulse);

    // First sample should be non-zero
    assert!(output[0] != 0.0);
    // Should decay over time (lowpass behavior)
    assert!(output[10].abs() < output[0].abs());
}

#[test]
fn test_no_nan_or_inf() {
    let mut filter = MoogModule::new(0.9, 0.9); // High settings
    // Generate sine wave samples
    let input_data: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();

    let output = filter.process_vec(input_data);

    for (i, sample) in output.iter().enumerate() {
        assert!(sample.is_finite(), "Found NaN or Inf at index {}: {}", i, sample);
        assert!(sample.abs() < 10.0, "Output too large at index {}: {}", i, sample);
    }
}

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = MoogModule::new(0.7, 0.8);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input);

    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Moog Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_stability_over_time() {
    let mut filter = MoogModule::new(0.7, 0.8);

    // Process many samples to test long-term stability
    // Ensures filter decays properly and doesn't go to infinity
    for _ in 0..10 {
        let input: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.01).sin()).collect();
        let output = filter.process_vec(input);

        // Check last few samples are still reasonable
        for &sample in output.iter().rev().take(10) {
            assert!(sample.is_finite() && sample.abs() < 2.0);
        }
    }
}

#[test]
fn test_set_cutoff_takes_effect_at_runtime() {
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.2).sin()).collect();

    // Two identical modules, then diverge them via the runtime setter.
    let mut low = MoogModule::new(0.5, 0.2);
    let mut high = MoogModule::new(0.5, 0.2);
    assert!(low.set_cutoff(0.02));
    assert!(high.set_cutoff(0.9));

    let low_output = low.process_vec(input.clone());
    let high_output = high.process_vec(input.clone());

    assert_ne!(
        low_output, high_output,
        "set_cutoff should change the filter response at runtime"
    );

    // A lower cutoff attenuates the signal more: compare RMS energy.
    let rms = |data: &[f32]| -> f32 {
        (data.iter().map(|sample| sample * sample).sum::<f32>() / data.len() as f32).sqrt()
    };
    assert!(
        rms(&low_output) < rms(&high_output),
        "lower cutoff should produce a quieter (more filtered) signal"
    );
}

#[test]
fn test_set_resonance_takes_effect_at_runtime() {
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.2).sin()).collect();

    let mut flat = MoogModule::new(0.3, 0.0);
    let mut resonant = MoogModule::new(0.3, 0.0);
    assert!(resonant.set_resonance(3.5));

    let flat_output = flat.process_vec(input.clone());
    let resonant_output = resonant.process_vec(input);

    assert_ne!(
        flat_output, resonant_output,
        "set_resonance should change the filter response at runtime"
    );
}

#[test]
fn test_setters_clamp_out_of_range() {
    let mut filter = MoogModule::new(0.5, 0.5);

    assert!(filter.set_cutoff(MAX_CUTOFF + 10.0));
    assert!(filter.set_cutoff(MIN_CUTOFF - 10.0));
    assert!(filter.set_resonance(MAX_RESONANCE + 10.0));
    assert!(filter.set_resonance(MIN_RESONANCE - 10.0));

    // The clamped module must still process without producing NaN/Inf.
    let input: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();
    let output = filter.process_vec(input);
    assert!(output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_setters_reject_non_finite_values() {
    // Two modules with identical construction and therefore identical
    // internal state, so their processing stays comparable.
    let mut control = MoogModule::new(0.5, 0.5);
    let mut filter = MoogModule::new(0.5, 0.5);

    assert!(!filter.set_cutoff(f32::NAN));
    assert!(!filter.set_cutoff(f32::INFINITY));
    assert!(!filter.set_cutoff(f32::NEG_INFINITY));
    assert!(!filter.set_resonance(f32::NAN));
    assert!(!filter.set_resonance(f32::INFINITY));
    assert!(!filter.set_resonance(f32::NEG_INFINITY));

    let input: Vec<f32> = (0..64).map(|i| (i as f32 * 0.1).sin()).collect();
    let baseline = control.process_vec(input.clone());
    let after_reject = filter.process_vec(input);
    assert_eq!(
        baseline, after_reject,
        "rejected parameters must not change module behavior"
    );
}

#[test]
fn test_constructor_rejects_non_finite_parameters() {
    // Illegal construction parameters fall back to safe defaults instead of
    // poisoning the filter state.
    let mut filter = MoogModule::new(f32::NAN, f32::INFINITY);
    let output = filter.process_vec(generate_silence_samples());
    assert!(output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_non_finite_input_samples_are_sanitized() {
    let mut filter = MoogModule::new(0.5, 0.5);
    let poisoned = vec![0.5, f32::NAN, f32::INFINITY, -0.5, f32::NEG_INFINITY, 0.25];
    let output = filter.process_vec(poisoned);

    assert!(
        output.iter().all(|sample| sample.is_finite()),
        "non-finite input must not produce non-finite output"
    );

    // And subsequent, clean input still behaves correctly after the poison:
    // the residual filter energy must decay toward zero, never blow up.
    let first = filter.process_vec(generate_silence_samples());
    let second = filter.process_vec(generate_silence_samples());
    assert!(first.iter().all(|sample| sample.is_finite()));
    assert!(second.iter().all(|sample| sample.is_finite()));

    let rms = |data: &[f32]| -> f32 {
        (data.iter().map(|sample| sample * sample).sum::<f32>() / data.len() as f32).sqrt()
    };
    assert!(
        rms(&second) < rms(&first),
        "filter should keep decaying after poisoned input (first={}, second={})",
        rms(&first),
        rms(&second)
    );
}
