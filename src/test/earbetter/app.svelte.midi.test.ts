import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';

import { create_memory_storage } from '../test_helpers.ts';
import { create_app } from './app_test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

interface FakeMidi {
	access: MIDIAccess;
	set_state: (id: string, state: MIDIPortDeviceState) => void;
}

const create_fake_midi = (): FakeMidi => {
	const target = new EventTarget();
	const inputs: Map<string, MIDIInput> = new Map();
	const access = Object.assign(target, { inputs }) as unknown as MIDIAccess;
	const set_state = (id: string, state: MIDIPortDeviceState): void => {
		inputs.set(id, { id, name: id, type: 'input', state } as MIDIInput);
		target.dispatchEvent(new Event('statechange'));
	};
	return { access, set_state };
};

beforeEach(() => {
	vi.stubGlobal('localStorage', create_memory_storage());
});
afterEach(() => {
	vi.unstubAllGlobals();
});

test('exposes no MIDI selection before access is granted', () => {
	const app = create_app();
	assert.strictEqual(app.midi_access, null);
	assert.strictEqual(app.midi_inputs, null);
	assert.strictEqual(app.selected_midi_input, null);
});

test('reflects devices connecting and disconnecting and falls back when the choice is unplugged', () => {
	const app = create_app();
	const { access, set_state } = create_fake_midi();
	app.midi_access = access;

	assert.strictEqual(app.selected_midi_input, null);
	set_state('a', 'connected');
	set_state('b', 'connected');
	assert.deepEqual(app.midi_inputs?.map((i) => i.id), ['a', 'b']);
	assert.strictEqual(app.selected_midi_input?.id, 'a');

	const chosen = app.midi_inputs!.find((i) => i.id === 'b')!;
	app.select_midi_input(chosen);
	assert.strictEqual(app.selected_midi_input?.id, 'b');

	// unplugging the chosen device falls back to the first available input, no refresh needed
	set_state('b', 'disconnected');
	assert.deepEqual(app.midi_inputs?.map((i) => i.id), ['a']);
	assert.strictEqual(app.selected_midi_input?.id, 'a');

	// unplugging the last input returns to the unselected state
	set_state('a', 'disconnected');
	assert.deepEqual(app.midi_inputs, []);
	assert.strictEqual(app.selected_midi_input, null);

	// plugging the remembered choice back restores it
	set_state('b', 'connected');
	set_state('a', 'connected');
	assert.strictEqual(app.selected_midi_input?.id, 'b');
});

test('the selection updates reactive effects on statechange', () => {
	const app = create_app();
	const { access, set_state } = create_fake_midi();
	app.midi_access = access;
	const seen: Array<string | null> = [];
	const destroy = $effect.root(() => {
		$effect(() => {
			seen.push(app.selected_midi_input?.id ?? null);
		});
	});
	flushSync();
	set_state('a', 'connected');
	flushSync();
	set_state('a', 'disconnected');
	flushSync();
	assert.deepEqual(seen, [null, 'a', null]);
	destroy();
});
