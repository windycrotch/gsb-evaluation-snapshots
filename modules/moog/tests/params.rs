use clawdio_moog::MoogModule;

fn sine(n: usize, freq: f32) -> Vec<f32> {
    (0..n).map(|i| (i as f32 * freq).sin()).collect()
}

fn all_finite(samples: &[f32]) -> bool {
    samples.iter().all(|s| s.is_finite())
}

#[test]
fn test_set_cutoff_changes_frequency_response() {
    // Use an impulse: a higher cutoff ring decays faster (wider bandwidth),
    // a lower cutoff ring lasts longer. Count samples above a noise floor.
    let impulse = |n: usize| {
        let mut v = vec![0.0f32; n];
        v[0] = 1.0;
        v
    };
    let ring_length = |cutoff: f32| {
        let mut module = MoogModule::new(0.9, 0.0);
        module.set_cutoff(cutoff);
        let output = module.process_vec(impulse(4096));
        output
            .iter()
            .rev()
            .position(|v| v.abs() > 1e-5)
            .map(|from_end| output.len() - from_end)
            .unwrap_or(0)
    };

    let low_ring = ring_length(0.05);
    let high_ring = ring_length(0.9);

    assert!(
        low_ring > high_ring,
        "lower cutoff must produce a longer ringing (got low={}, high={})",
        low_ring,
        high_ring
    );

    // Sanity: both settings respond to the impulse at all.
    assert!(low_ring > 10);
    assert!(high_ring > 1);
}

#[test]
fn test_set_resonance_changes_response() {
    let input = sine(1024, 0.05);

    let mut flat = MoogModule::new(0.3, 3.5);
    flat.set_resonance(0.0);
    let flat_out = flat.process_vec(input.clone());

    let mut resonant = MoogModule::new(0.3, 0.0);
    resonant.set_resonance(3.5);
    let resonant_out = resonant.process_vec(input);

    let energy = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>();
    assert!(
        (energy(&resonant_out) - energy(&flat_out)).abs() > f32::EPSILON,
        "resonance change must be observable in the output"
    );
    assert!(all_finite(&resonant_out));
    assert!(all_finite(&flat_out));
}

#[test]
fn test_parameter_switch_keeps_state_finite_and_continuous() {
    let mut module = MoogModule::new(0.2, 1.0);
    let mut previous_tail = 0.0f32;

    for block in 0..20 {
        // Sweep parameters wildly between every block.
        let cutoff = (block as f32 * 0.17) % 1.0;
        let resonance = (block as f32 * 0.9) % 4.0;
        module.set_cutoff(cutoff);
        module.set_resonance(resonance);

        let output = module.process_vec(sine(256, 0.13));
        assert!(all_finite(&output), "non-finite output after param switch");

        // Boundary between blocks must not jump beyond a generous click
        // threshold (state is retained, so consecutive blocks connect).
        let jump = (output[0] - previous_tail).abs();
        assert!(
            jump < 0.5,
            "parameter switch produced a discontinuity of {}",
            jump
        );
        previous_tail = *output.last().unwrap();
    }
}

#[test]
fn test_non_finite_setters_fall_back_safely() {
    let mut module = MoogModule::new(0.2, 1.0);
    module.set_cutoff(f32::NAN);
    module.set_resonance(f32::INFINITY);

    let output = module.process_vec(sine(512, 0.1));
    assert!(all_finite(&output));
    assert!(output.iter().all(|v| v.abs() <= 1.0));
}

#[test]
fn test_non_finite_input_is_sanitized() {
    let mut module = MoogModule::new(0.5, 3.0);
    let mut input = sine(256, 0.1);
    input[10] = f32::NAN;
    input[20] = f32::INFINITY;
    input[30] = f32::NEG_INFINITY;

    let output = module.process_vec(input);
    assert!(all_finite(&output), "NaN/Inf must never reach the output");

    // Filter recovers and stays finite on subsequent clean blocks.
    let after = module.process_vec(sine(512, 0.1));
    assert!(all_finite(&after));
}

#[test]
fn test_long_run_bounded_under_parameter_churn() {
    let mut module = MoogModule::new(0.5, 2.0);

    for block in 0..100 {
        // Cover the full valid parameter space, including extremes.
        let cutoff = [0.0, 0.01, 0.5, 0.99, 1.0][block % 5];
        let resonance = [0.0, 0.5, 3.5, 9.9, 10.0][block % 5];
        module.set_cutoff(cutoff);
        module.set_resonance(resonance);

        let output = module.process_vec(sine(512, 0.07));
        assert!(all_finite(&output), "non-finite sample at block {}", block);
        assert!(
            output.iter().all(|v| v.abs() <= 1.0),
            "output left the [-1, 1] clamp at block {}",
            block
        );
    }
}
