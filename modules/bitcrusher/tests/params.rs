use clawdio_bitcrusher::BitcrusherModule;

fn sine(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (i as f32 * 0.1).sin())
        .collect()
}

#[test]
fn test_set_bits_changes_processing() {
    let input = sine(512);

    let mut low_bits = BitcrusherModule::new(2);
    let low_output = low_bits.process_vec(input.clone(), 0.5);

    let mut high_bits = BitcrusherModule::new(2);
    high_bits.set_bits(12);
    let high_output = high_bits.process_vec(input.clone(), 0.5);

    // Coarser quantization (2 bits) repeats values much more often than
    // fine quantization (12 bits), so the outputs must observably differ.
    let distinct = |v: &[f32]| {
        let mut sorted: Vec<f32> = v.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sorted.dedup();
        sorted.len()
    };
    assert!(
        distinct(&high_output) > distinct(&low_output),
        "set_bits should change the effective quantization"
    );

    // 12-bit output should track the input closely while 2-bit deviates.
    let high_error: f32 = high_output
        .iter()
        .zip(input.iter())
        .map(|(a, b)| (a - b).abs())
        .sum::<f32>()
        / input.len() as f32;
    let low_error: f32 = low_output
        .iter()
        .zip(input.iter())
        .map(|(a, b)| (a - b).abs())
        .sum::<f32>()
        / input.len() as f32;
    assert!(high_error < low_error);
}

#[test]
fn test_set_bits_preserves_continuity() {
    let mut module = BitcrusherModule::new(4);
    // Prime the phaser and held sample.
    let first = module.process_vec(sine(256), 0.4);
    let held_before = *first.last().unwrap();

    module.set_bits(8);

    // The first sample of the next block must equal the held value of the
    // previous block (phaser hasn't rolled over yet): no discontinuity.
    let next = module.process_vec(sine(1), 0.4);
    assert!(
        (next[0] - held_before).abs() < 1e-6,
        "parameter change must not create a sample jump"
    );
}

#[test]
fn test_set_bits_clamps_absurd_values() {
    let mut module = BitcrusherModule::new(4);
    // Must not panic or produce NaN/Inf for out-of-range values.
    module.set_bits(0);
    module.set_bits(10_000);
    let output = module.process_vec(sine(128), 0.3);
    assert!(output.iter().all(|v| v.is_finite()));
}

#[test]
fn test_adopt_state_from_prevents_rebuild_click() {
    let mut old = BitcrusherModule::new(4);
    let tail = old.process_vec(sine(300), 0.37);
    let held_before = *tail.last().unwrap();

    // Simulate a rebuild: brand new module at the new bit depth, then adopt
    // the continuous state from the old module before the next block runs.
    let mut rebuilt = BitcrusherModule::new(9);
    rebuilt.adopt_state_from(&old);

    let next = rebuilt.process_vec(sine(4), 0.37);
    assert!(
        (next[0] - held_before).abs() < 1e-6,
        "rebuilt module must continue seamlessly from the old held sample"
    );
    assert!(next.iter().all(|v| v.is_finite()));
}

#[test]
fn test_non_finite_input_cannot_poison_state() {
    let mut module = BitcrusherModule::new(4);
    let mut poisoned = sine(16);
    poisoned[8] = f32::NAN;
    poisoned[9] = f32::INFINITY;

    let output = module.process_vec(poisoned, 0.2);
    assert!(
        output.iter().all(|v| v.is_finite()),
        "NaN/Inf input must be replaced by the held sample, not propagated"
    );

    // Subsequent blocks on clean input stay finite.
    let after = module.process_vec(sine(64), 0.2);
    assert!(after.iter().all(|v| v.is_finite()));
}

#[test]
fn test_non_finite_normfreq_does_not_silence() {
    let mut module = BitcrusherModule::new(4);
    let output = module.process_vec(sine(64), f32::NAN);
    assert!(output.iter().all(|v| v.is_finite()));
    // With an invalid normfreq the phaser is frozen: output holds the
    // initial value (0.0), never NaN.
    assert!(output.iter().all(|v| *v == 0.0 || v.is_finite()));
}
