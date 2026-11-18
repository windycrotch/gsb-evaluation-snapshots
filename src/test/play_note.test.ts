import { test, assert, vi, describe, beforeEach, afterEach } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';

import { SMOOTH_GAIN_TIME_CONSTANT, volume_to_gain } from '#lib/audio_helpers.ts';
import { start_playing_note, update_playing_gains } from '#lib/play_note.ts';
import type { Midi } from '#lib/music.ts';
import { create_fake_audio_context, type FakeGainNode } from './test_helpers.ts';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const create_state = (): {
	playing_notes: SvelteSet<Midi>;
	active_gains: Set<GainNode>;
} => ({ playing_notes: new SvelteSet<Midi>(), active_gains: new Set<GainNode>() });

const fake_gain = (state: { active_gains: Set<GainNode> }, index: number): FakeGainNode => {
	const gain = [...state.active_gains][index]! as unknown as FakeGainNode;
	return gain;
};

describe('start_playing_note', () => {
	test('registers its gain while sounding and unregisters it when stopped', () => {
		const audio = create_fake_audio_context();
		const state = create_state();

		const stop = start_playing_note(state, audio.ac, 60, 0.5);
		const gain = audio.gains[0]!;
		assert.strictEqual(gain.gain.value, volume_to_gain(0.5));
		assert.ok(state.active_gains.has(gain as unknown as GainNode));
		assert.ok(state.playing_notes.has(60));

		stop();
		assert.ok(!state.active_gains.has(gain as unknown as GainNode));
		assert.ok(!state.playing_notes.has(60));
	});

	test('works without an active_gains set', () => {
		const audio = create_fake_audio_context();
		const state = { playing_notes: new SvelteSet<Midi>() };
		const stop = start_playing_note(state, audio.ac, 60);
		assert.ok(state.playing_notes.has(60));
		assert.doesNotThrow(() => stop());
		assert.ok(!state.playing_notes.has(60));
	});
});

describe('update_playing_gains', () => {
	test('smoothly retargets every sounding gain with the shared time constant', () => {
		const audio = create_fake_audio_context();
		const state = create_state();
		const stop_first = start_playing_note(state, audio.ac, 60, 0.8);
		const stop_second = start_playing_note(state, audio.ac, 64, 0.8);
		assert.strictEqual(state.active_gains.size, 2);

		update_playing_gains(state.active_gains, audio.ac, 0.2);
		const expected = volume_to_gain(0.2);
		for (const gain of audio.gains) {
			assert.deepEqual(gain.gain.setTargetAtTime.mock.calls, [
				[expected, 0, SMOOTH_GAIN_TIME_CONSTANT]
			]);
		}

		// a stopped note leaves the set, so later volume changes skip it
		stop_first();
		const remaining = fake_gain(state, 0);
		const calls_before = remaining.gain.setTargetAtTime.mock.calls.length;
		update_playing_gains(state.active_gains, audio.ac, 1);
		assert.strictEqual(remaining.gain.setTargetAtTime.mock.calls.length, calls_before + 1);
		assert.strictEqual(remaining.gain.setTargetAtTime.mock.calls.at(-1)?.[0], 1);
		stop_second();
	});

	test('does nothing when no gains are sounding', () => {
		const audio = create_fake_audio_context();
		assert.doesNotThrow(() => update_playing_gains(new Set(), audio.ac, 0.5));
	});
});
