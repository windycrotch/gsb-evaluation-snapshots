import { test, describe, assert, vi, beforeEach, afterEach } from 'vitest';

import {
	DEFAULT_VOLUME,
	SMOOTH_GAIN_TIME_CONSTANT,
	volume_to_gain
} from '#lib/audio_helpers.ts';
import { create_fake_audio_context, create_memory_storage } from '../test_helpers.ts';
import { create_app } from './app_test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

beforeEach(() => {
	vi.stubGlobal('localStorage', create_memory_storage());
});
afterEach(() => {
	vi.unstubAllGlobals();
});

test('start_note holds a note until stop_note', () => {
	const audio = create_fake_audio_context();
	const app = create_app(audio);
	app.start_note(60);
	assert.deepEqual(audio.played, [60]);
	assert.ok(app.playing_notes.has(60));
	app.stop_note(60);
	assert.ok(!app.playing_notes.has(60));
});

test('start_note plays each note at most once while held', () => {
	const audio = create_fake_audio_context();
	const app = create_app(audio);
	app.start_note(60);
	app.start_note(60, 1);
	app.start_note(64);
	assert.deepEqual(audio.played, [60, 64]);
	app.stop_note(60);
	app.start_note(60);
	assert.deepEqual(audio.played, [60, 64, 60]);
});

test('stop_note ignores a note that is not held', () => {
	const app = create_app();
	app.stop_note(60);
	assert.strictEqual(app.playing_notes.size, 0);
});

test('each app holds its own notes', () => {
	const first = create_app();
	const second = create_app();
	first.start_note(60);
	second.stop_note(60);
	assert.ok(first.playing_notes.has(60));
});

test('register_form tracks the mounted form until it unmounts', () => {
	const app = create_app();
	const first = {} as HTMLFormElement;
	const second = {} as HTMLFormElement;
	const cleanup_first = app.register_form('level')(first);
	assert.strictEqual(app.form_els.level, first);
	const cleanup_second = app.register_form('level')(second);
	cleanup_first?.(); // a stale cleanup leaves the newer form registered
	assert.strictEqual(app.form_els.level, second);
	cleanup_second?.();
	assert.strictEqual(app.form_els.level, null);
	assert.strictEqual(app.form_els.realm, null);
});

describe('volume', () => {
	test('new notes start at the current volume gain', () => {
		const audio = create_fake_audio_context();
		const app = create_app(audio);
		app.volume = 0.5;
		app.start_note(60, 1); // full velocity, so the gain is the volume's gain directly
		const gain = audio.gains[0]!;
		assert.strictEqual(gain.gain.value, volume_to_gain(0.5));
		app.stop_note(60);
	});

	test('changing the volume retargets every gain that is currently sounding', () => {
		const audio = create_fake_audio_context();
		const app = create_app(audio);
		app.start_note(60);
		app.start_note(64);
		const [first_gain, second_gain] = audio.gains;
		const first_set_target = first_gain!.gain.setTargetAtTime;
		const second_set_target = second_gain!.gain.setTargetAtTime;
		assert.strictEqual(first_set_target.mock.calls.length, 0);
		assert.strictEqual(second_set_target.mock.calls.length, 0);

		app.volume = 0.25;
		const expected_gain = volume_to_gain(0.25);
		assert.deepEqual(first_set_target.mock.calls, [
			[expected_gain, 0, SMOOTH_GAIN_TIME_CONSTANT]
		]);
		assert.deepEqual(second_set_target.mock.calls, [
			[expected_gain, 0, SMOOTH_GAIN_TIME_CONSTANT]
		]);
	});

	test('a stopped note is no longer retargeted by later volume changes', () => {
		const audio = create_fake_audio_context();
		const app = create_app(audio);
		app.start_note(60);
		const gain = audio.gains[0]!;
		app.stop_note(60);
		const calls_after_stop = gain.gain.setTargetAtTime.mock.calls.length;

		app.volume = 0.3;
		assert.strictEqual(gain.gain.setTargetAtTime.mock.calls.length, calls_after_stop);
	});

	test('volume 0 silences sounding notes and volume 1 targets a gain of 1', () => {
		const audio = create_fake_audio_context();
		const app = create_app(audio);
		app.start_note(60);
		const gain = audio.gains[0]!;

		app.volume = 0;
		assert.strictEqual(gain.gain.setTargetAtTime.mock.calls.at(-1)?.[0], 0);

		app.volume = 1;
		assert.strictEqual(gain.gain.setTargetAtTime.mock.calls.at(-1)?.[0], 1);
		app.stop_note(60);
	});

	test('setting the same volume does not touch the audio graph', () => {
		const audio = create_fake_audio_context();
		const app = create_app(audio);
		app.start_note(60);
		const gain = audio.gains[0]!;
		app.volume = DEFAULT_VOLUME; // unchanged from the app default
		assert.strictEqual(gain.gain.setTargetAtTime.mock.calls.length, 0);
		app.stop_note(60);
	});
});
