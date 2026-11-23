use clawdio_moog::{MoogModule, DEFAULT_CUTOFF, DEFAULT_RESONANCE, MAX_CUTOFF};

fn sine_block(len: usize, freq: f32) -> Vec<f32> {
    (0..len).map(|i| (i as f32 * freq).sin()).collect()
}

#[test]
fn new_falls_back_to_defaults_for_illegal_values() {
    let silent = MoogModule::new(f32::NAN, f32::NAN);
    assert_eq!(silent.cutoff(), DEFAULT_CUTOFF);
    assert_eq!(silent.resonance(), DEFAULT_RESONANCE);

    let out_of_range = MoogModule::new(-1.0, -3.0);
    assert_eq!(out_of_range.cutoff(), DEFAULT_CUTOFF);
    assert_eq!(out_of_range.resonance(), DEFAULT_RESONANCE);
}

#[test]
fn set_cutoff_accepts_valid_values() {
    let mut module = MoogModule::new(0.2, 1.0);
    assert!(module.try_set_cutoff(0.5).is_ok());
    assert_eq!(module.cutoff(), 0.5);

    assert!(module.try_set_cutoff(0.0).is_ok());
    assert_eq!(module.cutoff(), 0.0);
}

#[test]
fn set_cutoff_rejects_illegal_values_and_keeps_previous() {
    let mut module = MoogModule::new(0.3, 1.0);

    for bad in [-0.01, MAX_CUTOFF as f64 + 0.01, f64::NAN, f64::INFINITY] {
        assert!(
            module.try_set_cutoff(bad).is_err(),
            "expected {bad} rejected"
        );
        assert_eq!(module.cutoff(), 0.3);
    }
}

#[test]
fn set_resonance_rejects_illegal_values_and_keeps_previous() {
    let mut module = MoogModule::new(0.3, 2.0);

    for bad in [-2.0, 1000.0, f64::NAN] {
        assert!(
            module.try_set_resonance(bad).is_err(),
            "expected {bad} rejected"
        );
        assert_eq!(module.resonance(), 2.0);
    }

    assert!(module.try_set_resonance(5.0).is_ok());
    assert_eq!(module.resonance(), 5.0);
}

#[test]
fn cutoff_change_alters_the_output_of_the_next_block() {
    let input = sine_block(256, 0.2);

    let mut low = MoogModule::new(0.05, 0.0);
    let mut low_output = low.process_vec(input.clone());
    low_output.extend(low.process_vec(input.clone()));

    let mut high = MoogModule::new(0.05, 0.0);
    let mut high_output = high.process_vec(input.clone());
    high.try_set_cutoff(0.9).unwrap();
    high_output.extend(high.process_vec(input));

    let mean_abs =
        |samples: &[f32]| -> f32 { samples[256..].iter().map(|s| s.abs()).sum::<f32>() / 256.0 };

    assert!(
        mean_abs(&high_output) > mean_abs(&low_output),
        "raising the cutoff should let more signal through"
    );
}

#[test]
fn parameter_change_preserves_filter_state() {
    // Two identically seeded modules, one of which gets a parameter change in
    // the middle. The output must remain continuous (no reset click) - the
    // sample right after the change must stay close to the previous one.
    let input = sine_block(64, 0.05);

    let mut module = MoogModule::new(0.25, 2.0);
    let first: Vec<f32> = module.process_vec(input.clone());
    module.try_set_cutoff(0.26).unwrap();
    let second: Vec<f32> = module.process_vec(input);

    let boundary = first[first.len() - 1];
    let after = second[0];
    assert!(
        (after - boundary).abs() < 0.5,
        "output jumped from {boundary} to {after} across the parameter change"
    );
}

#[test]
fn rapid_parameter_updates_leave_the_last_value_in_effect() {
    let mut module = MoogModule::new(0.1, 1.0);

    for value in [0.2_f64, 0.3, 0.4, 0.55, 0.7] {
        module.try_set_cutoff(value).unwrap();
    }
    // Illegal values interleaved must not overwrite the last legal one.
    assert!(module.try_set_cutoff(f64::NAN).is_err());
    assert!(module.try_set_cutoff(-1.0).is_err());

    assert!((module.cutoff() - 0.7).abs() < f32::EPSILON);
}

#[test]
fn output_stays_finite_after_rejected_parameters() {
    let mut module = MoogModule::new(0.4, 2.0);
    let _ = module.try_set_cutoff(f64::NAN);
    let _ = module.try_set_resonance(f64::NAN);

    let output = module.process_vec(sine_block(512, 0.1));
    assert!(output.iter().all(|s| s.is_finite()));
    assert!(
        output.iter().any(|s| s.abs() > 1e-6),
        "expected audible output"
    );
}
