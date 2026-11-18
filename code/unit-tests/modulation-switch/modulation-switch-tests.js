// Microtonal Fabric
//
// Local verification for the Sound Builder FM/AM switch path
// (Tone.play / Instrument.playWith / ModulatorSet enable setters).
//
// All audio objects are fakes from fake-audio.js; every gain write is recorded.
// Runs unchanged in the browser (modulation-switch-test.html) and under Node
// (run-node-test.js loads the real sound sources and calls runModulationSwitchTests()).

"use strict";

function runModulationSwitchTests() {

    const results = [];
    const check = (name, condition, detail) =>
        results.push({ name: name, pass: !!condition, detail: detail === undefined ? "" : String(detail) });
    const assert = (name, actual, expected) =>
        check(name, actual === expected, `actual=${actual}, expected=${expected}`);
    const assertApprox = (name, actual, expected) =>
        check(name, actual != undefined && Math.abs(actual - expected) < 1e-9, `actual=${actual}, expected=${expected}`);
    const assertNoThrow = (name, action) => {
        try { action(); check(name, true); }
        catch (ex) { check(name, false, `${ex.constructor.name}: ${ex.message}`); }
    }; //assertNoThrow

    const usage = soundDefinitionSet.playControl.usage;
    const modulationData = masterDepth => ({ masterDepth: masterDepth, modes: [{ frequency: 2, depth: 25 }] });
    // dataset accepted by Instrument.data / Tone.data:
    const fullDataset = (fmMasterDepth, amMasterDepth) => ({
        gainCompensation: {
            masterGain: 1, middleFrequency: 300, lowFrequency: 100,
            lowFrequencyCompensationGain: 1, highFrequencyCompensationGain: 1,
        },
        oscillator: { type: "triangle", Fourier: [] },
        gainEnvelope: { stages: [], dampingSustain: 0.02 },
        detuneEnvelope: { stages: [], dampingSustain: 0.02 },
        frequencyModulation: {
            absoluteFrequency: modulationData(fmMasterDepth),
            relativeFrequency: modulationData(fmMasterDepth),
            envelope: { stages: [], dampingSustain: 0.02 },
        },
        amplitudeModulation: {
            absoluteFrequency: modulationData(amMasterDepth),
            relativeFrequency: modulationData(amMasterDepth),
            envelope: { stages: [], dampingSustain: 0.02 },
        },
        filter: [{ present: true, index: 0, type: "lowpass", frequency: 350, Q: 1 }],
    }); //fullDataset

    // Identify nodes of a Tone/Instrument through the fake node registry.
    // The main oscillator is the only oscillator whose frequency parameter
    // receives a connection (from the FM envelope gain node).
    const findOscillator = () => fakeAudio.nodeRegistry
        .find(n => n.nodeName === "FakeOscillatorNode" && n.frequency.inputs.length > 0);
    // FM envelope gain node: connects to the main oscillator's frequency parameter.
    const findFmEnvelopeNode = () => {
        const oscillator = findOscillator();
        return fakeAudio.nodeRegistry.find(n => n.outputs.some(o => o === oscillator.frequency));
    }; //findFmEnvelopeNode
    // AM envelope gain node: connects to another gain node's gain parameter
    // (amplitudeModulationNode.gain), distinct from the FM target above.
    const findAmEnvelopeNode = () => {
        const oscillator = findOscillator();
        return fakeAudio.nodeRegistry.find(n =>
            n.outputs.some(o => o instanceof fakeAudio.FakeAudioParam && o.name === "gain")
            && !n.outputs.some(o => o === oscillator.frequency));
    }; //findAmEnvelopeNode
    // The Tone-level master depth node feeding an envelope node (the node that
    // Instrument.playWith actually toggles). It has a single unique output target,
    // whereas the Instrument-level master fans out to every tone.
    const toneMasterDepthOf = envelopeNode => envelopeNode.inputs
        .find(node => new Set(node.outputs).size === 1);

    // ---------------------------------------------------------------------
    // Shared scenario builder, executed for FM and AM symmetrically.
    // ---------------------------------------------------------------------
    const runScenarios = label => {

        const isFm = label === "FM";
        const usageBit = isFm ? usage.frequencyModulation : usage.amplitudeModulation;
        const envelopeNodeFinder = isFm ? findFmEnvelopeNode : findAmEnvelopeNode;
        const masterDepthOf = () => toneMasterDepthOf(envelopeNodeFinder());
        // The first data application creates the master depth node (gain 1);
        // the application re-applies instrument data whenever the tables change,
        // and that second application writes the slider's masterDepth into the node.
        const applyTwice = (instrument, fmDepth, amDepth) => {
            instrument.data = fullDataset(fmDepth, amDepth);
            instrument.data = fullDataset(fmDepth, amDepth);
        }; //applyTwice

        // Scenario 1: normal toggle after the modulator was connected.
        fakeAudio.reset();
        {
            const instrument = new Instrument([440, 550], 2);
            const expectedDepth = isFm ? 0.5 : 0.375;
            applyTwice(instrument, 0.5, 0.375);
            const master = masterDepthOf();
            assertApprox(`${label} 1. initial master depth`, master.gain.value, expectedDepth);
            assertNoThrow(`${label} 1. switch off does not throw`, () => instrument.playWith(usageBit, false));
            assert(`${label} 1. depth writes zero while off`, master.gain.value, 0);
            assertNoThrow(`${label} 1. switch on does not throw`, () => instrument.playWith(usageBit, true));
            assertApprox(`${label} 1. depth restored after on`, master.gain.value, expectedDepth);
            check(`${label} 1. zero write recorded while off`, fakeAudio.writesOf(master).some(v => v === 0),
                fakeAudio.writesOf(master).join(", "));
        }

        // Scenario 2: toggles BEFORE the master depth node exists (no data applied yet).
        fakeAudio.reset();
        {
            const instrument = new Instrument([440], 1);
            assertNoThrow(`${label} 2. off before connection does not throw`, () => instrument.playWith(usageBit, false));
            assertNoThrow(`${label} 2. on before connection does not throw`, () => instrument.playWith(usageBit, true));
            assertNoThrow(`${label} 2. off again before connection does not throw`, () => instrument.playWith(usageBit, false));
            // Now the modulator gets connected for the first time; the recorded
            // "off" state must survive and force the newly created master node to zero.
            instrument.data = fullDataset(0.5, 0.375);
            const master = masterDepthOf();
            assert(`${label} 2. stays off when connection is established later`, master.gain.value, 0);
            assertNoThrow(`${label} 2. on after late connection does not throw`, () => instrument.playWith(usageBit, true));
            // The preserved depth is the node's value at creation time; verify the
            // round trip off -> on restores that exact saved value.
            const savedAfterLateOn = master.gain.value;
            instrument.playWith(usageBit, false);
            assert(`${label} 2. off after late on writes zero`, master.gain.value, 0);
            instrument.playWith(usageBit, true);
            assert(`${label} 2. on restores the previously saved depth`, master.gain.value, savedAfterLateOn);
        }

        // Scenario 3: repeated off must not overwrite the saved depth with 0.
        fakeAudio.reset();
        {
            const instrument = new Instrument([440], 1);
            const expectedDepth = isFm ? 0.25 : 0.125;
            applyTwice(instrument, 0.25, 0.125);
            const master = masterDepthOf();
            instrument.playWith(usageBit, false); // saves 0.25 / 0.125, writes 0
            assertNoThrow(`${label} 3. second off does not throw`, () => instrument.playWith(usageBit, false));
            assertNoThrow(`${label} 3. third off does not throw`, () => instrument.playWith(usageBit, false));
            assert(`${label} 3. still zero while off`, master.gain.value, 0);
            instrument.playWith(usageBit, true);
            assertApprox(`${label} 3. original depth survives repeated off`, master.gain.value, expectedDepth);
        }

        // Direct ModulatorSet/Tone-level coverage of the same paths.
        fakeAudio.reset();
        {
            const context = new fakeAudio.FakeAudioContext();
            const tone = new Tone(context, 440, 1);
            // before connectToAudioParameters: no master depth nodes at all
            assertNoThrow(`${label} 4. raw setter off before connect`,
                () => { isFm ? (tone.frequencyModulationEnable = false) : (tone.amplitudeModulationEnable = false); });
            assertNoThrow(`${label} 4. raw setter on before connect`,
                () => { isFm ? (tone.frequencyModulationEnable = true) : (tone.amplitudeModulationEnable = true); });
            tone.data = fullDataset(0.4, 0.3);
            tone.connectToAudioParameters(tone.frequencyModulatorTarget, tone.amplitudeModulatorTarget);
            const target = isFm ? tone.frequencyModulatorTarget : tone.amplitudeModulatorTarget;
            const master = fakeAudio.sourceNodeOf(target);
            // second data application populates the now-existing master node
            tone.data = fullDataset(0.4, 0.3);
            const expected = isFm ? 0.4 : 0.3;
            assertApprox(`${label} 4. direct normal off/on restores depth`, (() => {
                const setter = value => {
                    if (isFm) tone.frequencyModulationEnable = value;
                    else tone.amplitudeModulationEnable = value;
                };
                setter(false);
                if (master.gain.value !== 0) return -1;
                setter(false); // repeated off: saved depth must not be replaced by 0
                setter(true);
                return master.gain.value;
            })(), expected);
            check(`${label} 4. getter reflects state`,
                (isFm ? tone.frequencyModulationEnable : tone.amplitudeModulationEnable) === true);
        }

    }; //runScenarios

    runScenarios("FM");
    runScenarios("AM");

    // ---------------------------------------------------------------------
    // Scenario 4: unknown usage is a silent no-op in Instrument.playWith.
    // ---------------------------------------------------------------------
    fakeAudio.reset();
    {
        const instrument = new Instrument([440], 1);
        instrument.data = fullDataset(0.5, 0.5);
        const eventCountBefore = fakeAudio.events.length;
        const fmMasterBefore = toneMasterDepthOf(findFmEnvelopeNode()).gain.value;
        const amMasterBefore = toneMasterDepthOf(findAmEnvelopeNode()).gain.value;
        let threw = false;
        try {
            instrument.playWith(0, true);
            instrument.playWith(255, false);
            instrument.playWith(undefined, true);
            instrument.playWith(-7, false);
        } catch (ex) { threw = true; }
        check("unknown usage never throws", !threw);
        assert("unknown usage produces no audio writes", fakeAudio.events.length, eventCountBefore);
        assert("unknown usage leaves FM master depth untouched",
            toneMasterDepthOf(findFmEnvelopeNode()).gain.value, fmMasterBefore);
        assert("unknown usage leaves AM master depth untouched",
            toneMasterDepthOf(findAmEnvelopeNode()).gain.value, amMasterBefore);
    }

    // ---------------------------------------------------------------------
    // Requirement 3: Instrument.playWith dispatch stays observable for every
    // documented usage bit value (values taken from soundDefinitionSet).
    // ---------------------------------------------------------------------
    fakeAudio.reset();
    {
        const instrument = new Instrument([440, 550], 2);
        instrument.data = fullDataset(0.5, 0.5);
        const dispatchChecks = [
            ["gainEnvelope", usage.gainEnvelope,
                () => instrument.playWith(usage.gainEnvelope, false)],
            ["detuneEnvelope", usage.detuneEnvelope,
                () => instrument.playWith(usage.detuneEnvelope, false)],
            ["frequencyModulationEnvelope", usage.frequencyModulationEnvelope,
                () => instrument.playWith(usage.frequencyModulationEnvelope, false)],
            ["amplitudeModulationEnvelope", usage.amplitudeModulationEnvelope,
                () => instrument.playWith(usage.amplitudeModulationEnvelope, false)],
        ];
        for (const [name, bitValue] of dispatchChecks)
            assert(`usage bit value ${name}`, bitValue, {
                gainEnvelope: 4, detuneEnvelope: 8,
                frequencyModulationEnvelope: 16, amplitudeModulationEnvelope: 32,
            }[name]);
        assert("usage bit value frequencyModulation", usage.frequencyModulation, 1);
        assert("usage bit value amplitudeModulation", usage.amplitudeModulation, 2);
        assert("usage bit value filters", usage.filters, 64);
        assert("usage bit value gainCompensation", usage.gainCompensation, 128);

        assertNoThrow("dispatch gainEnvelope", () => instrument.playWith(usage.gainEnvelope, false));
        assertNoThrow("dispatch detuneEnvelope", () => instrument.playWith(usage.detuneEnvelope, false));
        assertNoThrow("dispatch FM envelope", () => instrument.playWith(usage.frequencyModulationEnvelope, false));
        assertNoThrow("dispatch AM envelope", () => instrument.playWith(usage.amplitudeModulationEnvelope, false));
        assertNoThrow("dispatch FM", () => instrument.playWith(usage.frequencyModulation, false));
        assertNoThrow("dispatch AM", () => instrument.playWith(usage.amplitudeModulation, false));

        // filters: toggling the filter chain rewires connections between master gain and destination.
        assertNoThrow("dispatch filters off", () => instrument.playWith(usage.filters, false));
        const connectionCountWhileOff = fakeAudio.connections.length;
        assertNoThrow("dispatch filters on", () => instrument.playWith(usage.filters, true));
        check("filter toggle rewires connections", fakeAudio.connections.length > connectionCountWhileOff,
            `connections ${connectionCountWhileOff} (off) -> ${fakeAudio.connections.length} (on)`);

        // gain compensation: disabling falls back to the default unity compensation,
        // re-enabling restores the saved dataset values; both write through the chain.
        const oscillator = findOscillator();
        const toneCompensationNode = oscillator.outputs[0]; // mainOscillator -> frequencyCompensationGainNode
        assertNoThrow("dispatch gainCompensation off", () => instrument.playWith(usage.gainCompensation, false));
        assert("gain compensation falls back to unity when off", toneCompensationNode.gain.value, 1);
        const writesWhileOff = fakeAudio.writesOf(toneCompensationNode).length;
        assertNoThrow("dispatch gainCompensation on", () => instrument.playWith(usage.gainCompensation, true));
        check("gain compensation re-enable rewrites tone gain",
            fakeAudio.writesOf(toneCompensationNode).length > writesWhileOff);
        check("re-enabled compensation stays finite", Number.isFinite(toneCompensationNode.gain.value));
    }

    // ---------------------------------------------------------------------
    // Entry-point contract: Tone.play(on, frequency, dynamicGain) sets
    // oscillator frequency and dynamic gain first, then fires the four
    // envelopes in the fixed order gain, detune, FM, AM.
    // ---------------------------------------------------------------------
    fakeAudio.reset();
    {
        const context = new fakeAudio.FakeAudioContext();
        const tone = new Tone(context, 440, 1);
        tone.data = fullDataset(0.5, 0.5);
        tone.connectToAudioParameters(tone.frequencyModulatorTarget, tone.amplitudeModulatorTarget);
        fakeAudio.events.splice(0); // ignore construction/connection noise

        assertNoThrow("Tone.play(true, f, g) does not throw", () => tone.play(true, 660, 0.7));
        const osc = fakeAudio.nodeRegistry.find(n => n.nodeName === "FakeOscillatorNode" && n.frequency.inputs.length > 0);
        assert("Tone.play sets main oscillator frequency", osc.frequency.value, 660);
        // Only dynamicGainNode ever receives a 0.7 gain write in this fixture.
        const dynamicGainNode = fakeAudio.nodeRegistry.find(n =>
            n.nodeName === "FakeGainNode" && fakeAudio.writesOf(n).includes(0.7));
        check("Tone.play sets dynamic gain", !!dynamicGainNode, "no gain node received a 0.7 write");

        const envelopeOrder = fakeAudio.events
            .filter(e => e.kind === "cancelScheduledValues")
            .map(e => e.node);
        // the four envelope targets in play() order:
        const gainEnvelopeNode = fakeAudio.nodeRegistry.find(n =>
            n.nodeName === "FakeGainNode" && n.outputs.length === 0 && n.inputs.length === 1);
        const fmEnvelopeNode = findFmEnvelopeNode();
        const amEnvelopeNode = findAmEnvelopeNode();
        const expectedOrder = [gainEnvelopeNode, osc, fmEnvelopeNode, amEnvelopeNode];
        check("four envelopes fired in order gain, detune, FM, AM",
            expectedOrder.every((node, index) => envelopeOrder[index] === node),
            envelopeOrder.map(n => n.id).join(" -> "));

        // off path still plays all four envelopes in the same order and must not throw
        assertNoThrow("Tone.play(false) does not throw", () => tone.play(false));
        const offOrder = fakeAudio.events
            .filter(e => e.kind === "cancelScheduledValues")
            .map(e => e.node)
            .filter(node => expectedOrder.includes(node))
            .slice(-4);
        check("Tone.play(false) still drives all four envelopes",
            expectedOrder.every((node, index) => offOrder[index] === node));
        // defaulted arguments
        assertNoThrow("Tone.play(true) with nulls does not throw", () => tone.play(true, null, null));
        assert("Tone.play(true, null) keeps initial frequency", osc.frequency.value, 440);
    }

    return results;

} //runModulationSwitchTests
