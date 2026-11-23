use clawdio_bitcrusher::{BitcrusherModule, InvalidParameter, MAX_BITS, MIN_BITS};

/// Build a monotonically rising ramp so each sample has a distinct value.
fn ramp(len: usize) -> Vec<f32> {
    (0..len).map(|i| i as f32 / len as f32).collect()
}

#[test]
fn new_clamps_illegal_bit_depth_to_default() {
    // The constructor must never produce a module that divides by a zero step.
    assert_eq!(BitcrusherModule::new(0).bits(), 4);
}

#[test]
fn set_bits_accepts_values_inside_the_range() {
    let mut module = BitcrusherModule::new(8);
    assert!(module.try_set_bits(16.0).is_ok());
    assert_eq!(module.bits(), 16);

    assert!(module.try_set_bits(MIN_BITS as f64).is_ok());
    assert_eq!(module.bits(), MIN_BITS as usize);

    assert!(module.try_set_bits(MAX_BITS as f64).is_ok());
    assert_eq!(module.bits(), MAX_BITS as usize);
}

#[test]
fn set_bits_rejects_illegal_values_and_keeps_previous() {
    let mut module = BitcrusherModule::new(8);

    for bad in [0.0, -1.0, 33.0, f64::NAN, f64::INFINITY, 4.5] {
        let result = module.try_set_bits(bad);
        assert!(result.is_err(), "expected {bad} to be rejected");
        assert_eq!(
            module.bits(),
            8,
            "illegal value {bad} must not change the bit depth"
        );
    }
}

#[test]
fn rejected_value_reports_the_parameter_name() {
    let mut module = BitcrusherModule::new(8);
    let error: InvalidParameter = module.try_set_bits(0.0).unwrap_err();
    assert_eq!(error.parameter, "bits");
}

#[test]
fn bit_depth_change_takes_effect_without_rebuilding_the_module() {
    // Coarse (2 bit) vs fine (16 bit) quantisation over the same input should
    // produce measurably different output, and the change must apply to the
    // very next block without touching the phaser.
    let input = ramp(64);

    let mut module = BitcrusherModule::new(2);
    let coarse = module.process_vec(input.clone(), 1.0);

    module.try_set_bits(16.0).unwrap();
    let fine = module.process_vec(input, 1.0);

    let max_coarse_error = coarse.iter().map(|v| *v).fold(0.0_f32, f32::max);
    let differences = coarse
        .iter()
        .zip(fine.iter())
        .filter(|(a, b)| a != b)
        .count();

    assert!(
        differences > coarse.len() / 2,
        "changing bits should change most samples (changed {differences})"
    );
    assert!(max_coarse_error <= 1.0);
}

#[test]
fn parameter_change_keeps_phaser_phase_continuous() {
    // Run 0.5 of a phase step, change the bit depth, then run to completion.
    // If `set_bits` reset the phaser we would not hold the same number of
    // samples across the boundary.
    let block = vec![0.5_f32; 8];

    let mut continuous = BitcrusherModule::new(4);
    let mut before = continuous.process_vec(block.clone(), 0.5);
    continuous.try_set_bits(8.0).unwrap();
    let mut after = continuous.process_vec(block, 0.5);
    before.append(&mut after);

    // A fresh module that never saw the change but uses the final bit depth.
    let mut fresh = BitcrusherModule::new(8);
    let expected = fresh.process_vec(vec![0.5_f32; 16], 0.5);

    // The number of "updated" samples must match: 0.5 phase per sample means a
    // hold updates every other sample, and it must not restart at the change.
    let held = |samples: &[f32]| samples.iter().filter(|s| **s != 0.0).count();
    assert_eq!(held(&before), held(&expected));
}

#[test]
fn process_stays_finite_for_extreme_normfreq() {
    let mut module = BitcrusherModule::new(4);
    let output = module.process_vec(vec![0.25_f32; 128], f32::NAN);
    assert!(output.iter().all(|s| s.is_finite()));

    let output = module.process_vec(vec![0.25_f32; 128], 42.0);
    assert!(output.iter().all(|s| s.is_finite()));
}

#[test]
fn output_is_within_signal_range() {
    let mut module = BitcrusherModule::new(2);
    let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.05).sin() * 0.9).collect();
    let output = module.process_vec(input, 0.3);
    assert!(output.iter().all(|s| s.abs() <= 1.0));
}
