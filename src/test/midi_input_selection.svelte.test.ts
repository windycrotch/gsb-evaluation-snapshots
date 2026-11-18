import { test, assert } from 'vitest';
import { flushSync } from 'svelte';

import { MidiInputs } from '#lib/midi_inputs.svelte.ts';
import { MidiInputSelection } from '#lib/midi_input_selection.svelte.ts';

interface FakeAccess {
	access: MIDIAccess;
	inputs: Map<string, MIDIInput>;
	set_state: (id: string, state: MIDIPortDeviceState) => void;
}

const create_access = (): FakeAccess => {
	const target = new EventTarget();
	const inputs: Map<string, MIDIInput> = new Map();
	const access = Object.assign(target, { inputs }) as unknown as MIDIAccess;
	const set_state = (id: string, state: MIDIPortDeviceState): void => {
		inputs.set(id, { id, name: id, type: 'input', state } as MIDIInput);
		target.dispatchEvent(new Event('statechange'));
	};
	return { access, inputs, set_state };
};

const input = (selection: MidiInputSelection, id: string): MIDIInput => {
	const found = selection.current.find((i) => i.id === id);
	assert.ok(found, `expected input ${id} to be connected`);
	return found;
};

test('has no selection while no devices are connected', () => {
	const { access } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	assert.deepEqual(selection.current, []);
	assert.strictEqual(selection.selected, null);
});

test('selects the first connected input and follows statechange without a refresh', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	assert.deepEqual(selection.current.map((i) => i.id), ['a']);
	assert.strictEqual(selection.selected?.id, 'a');

	set_state('b', 'connected');
	assert.deepEqual(selection.current.map((i) => i.id), ['a', 'b']);
	// a newly plugged-in device appears without changing the selection
	assert.strictEqual(selection.selected?.id, 'a');
});

test('keeps an explicit choice when other devices connect and disconnect', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	set_state('b', 'connected');
	selection.select(input(selection, 'b'));
	assert.strictEqual(selection.selected?.id, 'b');

	set_state('a', 'disconnected');
	assert.deepEqual(selection.current.map((i) => i.id), ['b']);
	assert.strictEqual(selection.selected?.id, 'b');

	set_state('a', 'connected');
	selection.select(input(selection, 'a'));
	set_state('b', 'disconnected');
	// only `a` remains, still selected
	assert.strictEqual(selection.selected?.id, 'a');
});

test('falls back to the first available input when the chosen one is unplugged', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	set_state('b', 'connected');
	set_state('c', 'connected');
	selection.select(input(selection, 'c'));
	assert.strictEqual(selection.selected?.id, 'c');

	set_state('c', 'disconnected');
	// the chosen device is gone, so the selection falls back to the first available one
	assert.deepEqual(selection.current.map((i) => i.id), ['a', 'b']);
	assert.strictEqual(selection.selected?.id, 'a');
});

test('returns to no selection when every input is unplugged', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	selection.select(input(selection, 'a'));
	set_state('a', 'disconnected');
	assert.deepEqual(selection.current, []);
	assert.strictEqual(selection.selected, null);
});

test('restores the chosen input after it is plugged back in', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	set_state('b', 'connected');
	selection.select(input(selection, 'b'));
	set_state('b', 'disconnected');
	assert.strictEqual(selection.selected?.id, 'a');

	set_state('b', 'connected');
	assert.strictEqual(selection.selected?.id, 'b');
});

test('clearing the explicit choice falls back to the first input', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	set_state('a', 'connected');
	set_state('b', 'connected');
	selection.select(input(selection, 'b'));
	selection.select(null);
	assert.strictEqual(selection.selected?.id, 'a');
});

test('updates effects observing the selection on plug and unplug', () => {
	const { access, set_state } = create_access();
	const selection = new MidiInputSelection(new MidiInputs(access));
	const seen: Array<string | null> = [];
	const destroy = $effect.root(() => {
		$effect(() => {
			seen.push(selection.selected?.id ?? null);
		});
	});
	flushSync();
	set_state('a', 'connected');
	flushSync();
	set_state('b', 'connected');
	flushSync();
	selection.select(input(selection, 'b'));
	flushSync();
	set_state('b', 'disconnected');
	flushSync();
	set_state('a', 'disconnected');
	flushSync();
	assert.deepEqual(seen, [null, 'a', 'a', 'b', 'a', null]);
	destroy();
});
