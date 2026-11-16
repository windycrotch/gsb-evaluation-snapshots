use clawdio_moog::MoogModule;
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
fn test_set_params_takes_effect_immediately() {
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.05).sin()).collect();

    // 1. Process a block with the old cutoff/resonance.
    let mut updated = MoogModule::new(0.065, 3.5);
    let first_block = updated.process_vec(input.clone());

    // 2. Update both cutoff and resonance at the same time.
    updated.set_params(0.5, 0.5);

    // 3. Process the same block again with the new parameters.
    let after_update = updated.process_vec(input.clone());

    // The two outputs must differ: the update actually changed the result.
    assert_ne!(
        first_block, after_update,
        "Changing cutoff/resonance must change the processed output"
    );
    assert!(
        after_update.iter().all(|sample| sample.is_finite()),
        "Output after parameter update must remain finite"
    );
}

#[test]
fn test_set_params_preserves_internal_state() {
    let input: Vec<f32> = (0..128).map(|i| (i as f32 * 0.03).sin()).collect();

    let mut module = MoogModule::new(0.065, 3.5);
    // Drive the four poles/input histories away from their zero initial state.
    let warmup = module.process_vec(input.clone());
    assert!(
        warmup.iter().any(|sample| *sample != 0.0),
        "Warm-up block should leave non-zero internal state"
    );

    // Update the parameters only; the pole outputs and input histories must
    // be retained, so the next block continues from the existing state.
    module.set_params(0.4, 1.0);
    let output = module.process_vec(input.clone());

    // A freshly constructed module starts from zero state, so its output for
    // the same block cannot match the stateful updated module.
    let mut fresh = MoogModule::new(0.4, 1.0);
    let fresh_output = fresh.process_vec(input.clone());
    assert_ne!(
        output, fresh_output,
        "set_params must not reset the four pole outputs or input histories"
    );
}

#[test]
fn test_set_params_matches_fresh_module_from_zero_state() {
    // When the internal state is still the initial all-zero state (nothing
    // has been processed yet), an updated module and a module built directly
    // with the new parameters are identical and must agree exactly.
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.04).sin()).collect();

    let mut updated = MoogModule::new(0.065, 3.5);
    updated.set_params(0.5, 0.5);
    let after_update = updated.process_vec(input.clone());

    let mut fresh = MoogModule::new(0.5, 0.5);
    let fresh_output = fresh.process_vec(input);

    assert_eq!(
        after_update, fresh_output,
        "From identical (zero) state, an updated module must match a module \
         built with the new cutoff and resonance"
    );
}

#[test]
fn test_set_params_is_reusable_and_repeated() {
    // Calling the entry point multiple times must be safe and each call must
    // be reflected in the very next processed block.
    let input: Vec<f32> = (0..128).map(|i| (i as f32 * 0.06).sin()).collect();

    let mut module = MoogModule::new(0.1, 0.2);
    module.set_params(0.3, 0.4);
    let first = module.process_vec(input.clone());

    module.set_params(0.8, 0.9);
    let second = module.process_vec(input.clone());

    assert_ne!(
        first, second,
        "Each set_params call must take effect on the next block"
    );
    assert!(second.iter().all(|sample| sample.is_finite()));
}
