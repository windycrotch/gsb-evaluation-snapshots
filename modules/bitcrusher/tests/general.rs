use clawdio_bitcrusher::{BitcrusherModule, MAX_BITS};
use test_helpers::{signal::generate_sine_wave, plotting::plot_waveform_comparison};

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = BitcrusherModule::new(4);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input, 0.420);

    // Bitcrusher creates a step-like pattern out of input signal
    // Technically the modified signal will be equal sometimes, but mostly not
    // So we check that (mostly) every point in signal is different
    let mut is_equal = 0;
    let mut is_diff = 0;
    for index in 0..original.len() {
        let sample_original = original[index];
        let sample_effect = output[index];

        if sample_original != sample_effect {
            is_diff += 1;
        } else {
            is_equal += 1;
        }
    }
    assert!(is_diff > is_equal, "Values should be less equal");


    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Bitcrusher Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_set_bits_takes_effect_at_runtime() {
    let input: Vec<f32> = vec![0.0, 0.12, -0.34, 0.56, -0.78, 0.9, -1.0];

    let mut coarse = BitcrusherModule::new(2);
    let coarse_output = coarse.process_vec(input.clone(), 1.0);

    // Reconfigure the same module at runtime instead of creating a new one.
    let mut fine = BitcrusherModule::new(2);
    assert!(fine.set_bits(12.0));
    let fine_output = fine.process_vec(input.clone(), 1.0);

    // A higher bit depth tracks the input more closely than a low one.
    let coarse_error: f32 = input
        .iter()
        .zip(coarse_output.iter())
        .map(|(a, b)| (a - b).abs())
        .sum();
    let fine_error: f32 = input
        .iter()
        .zip(fine_output.iter())
        .map(|(a, b)| (a - b).abs())
        .sum();
    assert!(
        fine_error < coarse_error,
        "set_bits should change the processing at runtime (fine={fine_error}, coarse={coarse_error})"
    );
}

#[test]
fn test_set_normfreq_takes_effect_at_runtime() {
    let input: Vec<f32> = (0..64).map(|i| (i as f32 * 0.3).sin()).collect();

    let mut module = BitcrusherModule::new(4);
    assert!(module.set_normfreq(1.0));
    // With normfreq 1.0 every sample is re-quantized.
    let fast = module.process_vec(input.clone(), 1.0);

    assert!(module.set_normfreq(0.01));
    // With a very low normfreq the output holds the same value for many
    // samples in a row.
    let slow = module.process_vec(input.clone(), 0.01);

    let slow_repeats = slow.windows(2).filter(|w| w[0] == w[1]).count();
    let fast_repeats = fast.windows(2).filter(|w| w[0] == w[1]).count();
    assert!(
        slow_repeats > fast_repeats,
        "set_normfreq should change the sample/hold rate at runtime"
    );
}

#[test]
fn test_set_bits_clamps_out_of_range() {
    let mut module = BitcrusherModule::new(4);

    assert!(module.set_bits((MAX_BITS as f32) + 50.0));
    // The module must still produce finite output at the clamped boundary.
    let output = module.process_vec(vec![0.5; 16], 0.5);
    assert!(output.iter().all(|sample| sample.is_finite()));

    assert!(module.set_bits(0.0));
    let output = module.process_vec(vec![0.5; 16], 0.5);
    assert!(output.iter().all(|sample| sample.is_finite()));

    // Floats are rounded, not truncated. Use fresh modules so internal
    // state can't skew the comparison.
    let mut rounded_module = BitcrusherModule::new(2);
    assert!(rounded_module.set_bits(3.6));
    let rounded = rounded_module.process_vec(vec![0.5; 4], 1.0);
    let mut reference = BitcrusherModule::new(4);
    let expected = reference.process_vec(vec![0.5; 4], 1.0);
    assert_eq!(rounded, expected);
}

#[test]
fn test_set_normfreq_clamps_out_of_range() {
    let mut module = BitcrusherModule::new(4);

    assert!(module.set_normfreq(5.0));
    let high = module.process_vec(vec![0.5; 8], 5.0);
    assert!(high.iter().all(|sample| sample.is_finite()));

    assert!(module.set_normfreq(-2.0));
    let low = module.process_vec(vec![0.5; 8], -2.0);
    assert!(low.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_setters_reject_non_finite_values() {
    // Two modules with identical construction and therefore identical
    // internal state, so their processing stays comparable.
    let mut control = BitcrusherModule::new(4);
    let mut module = BitcrusherModule::new(4);

    assert!(!module.set_bits(f32::NAN));
    assert!(!module.set_bits(f32::INFINITY));
    assert!(!module.set_bits(f32::NEG_INFINITY));
    assert!(!module.set_normfreq(f32::NAN));
    assert!(!module.set_normfreq(f32::INFINITY));
    assert!(!module.set_normfreq(f32::NEG_INFINITY));

    let input: Vec<f32> = vec![0.3; 16];
    let baseline = control.process_vec(input.clone(), 0.5);
    let after_reject = module.process_vec(input, 0.5);
    assert_eq!(
        baseline, after_reject,
        "rejected parameters must not change module behavior"
    );
}

#[test]
fn test_illegal_normfreq_argument_falls_back_safely() {
    let mut module = BitcrusherModule::new(4);
    assert!(module.set_normfreq(0.5));

    // Even if a non-finite value reaches process_vec directly, output stays finite.
    for illegal in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let output = module.process_vec(vec![0.2, -0.4, 0.7], illegal);
        assert!(
            output.iter().all(|sample| sample.is_finite()),
            "process_vec must never emit non-finite samples"
        );
    }
}

#[test]
fn test_non_finite_input_samples_are_sanitized() {
    let mut module = BitcrusherModule::new(4);
    let poisoned = vec![0.5, f32::NAN, f32::INFINITY, -0.5, f32::NEG_INFINITY];
    let output = module.process_vec(poisoned, 0.5);

    assert!(
        output.iter().all(|sample| sample.is_finite()),
        "non-finite input must not produce non-finite output"
    );
}
