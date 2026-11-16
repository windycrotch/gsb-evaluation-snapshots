use clawdio_bitcrusher::BitcrusherModule;
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
fn test_set_bits_takes_effect_immediately() {
    // With normfreq = 1.0 the phaser wraps on every sample, so each output
    // sample is simply the freshly quantized input. That makes the output a
    // memoryless function of the current parameters, which lets us compare
    // against a module built directly with the new parameters.
    let normfreq = 1.0;
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.05).sin()).collect();

    // 1. Process a block with the old bit depth.
    let mut updated = BitcrusherModule::new(4);
    let _first_block = updated.process_vec(input.clone(), normfreq);

    // 2. Change the bit depth at runtime.
    updated.set_bits(8);

    // 3. Process the same block again with the new bit depth.
    let after_update = updated.process_vec(input.clone(), normfreq);

    // The two outputs must differ: the update actually changed the result.
    let first_block = _first_block;
    assert_ne!(
        first_block, after_update,
        "Changing bits must change the processed output"
    );

    // A module constructed directly with the new parameters must produce the
    // exact same output for the same input (normfreq = 1.0 is memoryless).
    let mut fresh = BitcrusherModule::new(8);
    let fresh_output = fresh.process_vec(input.clone(), normfreq);
    assert_eq!(
        after_update, fresh_output,
        "Output after set_bits must match a module built with the new bits"
    );
}

#[test]
fn test_set_bits_preserves_internal_state() {
    // With a low normfreq most samples reuse the held `last` value. After an
    // update, the held value and phaser position must be retained rather than
    // reset to their initial (zero) values.
    let normfreq = 0.1;
    let input: Vec<f32> = (0..64).map(|i| 0.5 + 0.4 * (i as f32 * 0.13).sin()).collect();

    let mut module = BitcrusherModule::new(4);
    // Build up non-zero internal state (phaser position and held sample).
    let warmup = module.process_vec(input.clone(), normfreq);
    assert!(
        warmup.iter().any(|sample| *sample != 0.0),
        "Warm-up block should produce non-zero held values"
    );

    // Update only the bit depth; internal state must survive.
    module.set_bits(2);
    let output = module.process_vec(input.clone(), normfreq);

    // A freshly created module starts with phaser = 0 and last = 0, so its
    // output cannot match that of the stateful updated module here.
    let mut fresh = BitcrusherModule::new(2);
    let fresh_output = fresh.process_vec(input.clone(), normfreq);
    assert_ne!(
        output, fresh_output,
        "set_bits must not reset the phaser position or held sample"
    );
}

#[test]
fn test_set_bits_is_reusable_and_repeated() {
    // Calling the entry point multiple times must be safe and each call must
    // be reflected in the very next processed block.
    let normfreq = 1.0;
    let input: Vec<f32> = (0..128).map(|i| (i as f32 * 0.07).sin()).collect();

    let mut module = BitcrusherModule::new(2);
    module.set_bits(5);
    let out_five = module.process_vec(input.clone(), normfreq);

    module.set_bits(10);
    let out_ten = module.process_vec(input.clone(), normfreq);

    assert_ne!(out_five, out_ten, "Each set_bits call must take effect");

    let mut fresh_ten = BitcrusherModule::new(10);
    assert_eq!(
        out_ten,
        fresh_ten.process_vec(input, normfreq),
        "Latest set_bits value must be the effective one"
    );
}
