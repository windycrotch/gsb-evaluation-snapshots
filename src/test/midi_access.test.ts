import { test, assert, vi, beforeEach } from 'vitest';

import { request_access, reset_midi_access } from '#lib/midi_access.ts';
import { assert_rejects } from './test_helpers.ts';

const create_state = (): { midi_access: MIDIAccess | null } => ({ midi_access: null });
const create_access = (): MIDIAccess => ({ inputs: new Map() }) as unknown as MIDIAccess;

beforeEach(() => {
	reset_midi_access(create_state()); // the pending request is module state
});

test('stores the granted access', async () => {
	const state = create_state();
	const access = create_access();
	assert.strictEqual(await request_access(state, () => Promise.resolve(access)), access);
	assert.strictEqual(state.midi_access, access);
});

test('returns existing access without requesting', async () => {
	const access = create_access();
	const request = vi.fn(() => Promise.resolve(create_access()));
	assert.strictEqual(await request_access({ midi_access: access }, request), access);
	assert.strictEqual(request.mock.calls.length, 0);
});

test('shares one pending request between callers', async () => {
	const state = create_state();
	const access = create_access();
	const request = vi.fn(() => Promise.resolve(access));
	const [a, b] = await Promise.all([
		request_access(state, request),
		request_access(state, request)
	]);
	assert.strictEqual(a, access);
	assert.strictEqual(b, access);
	assert.strictEqual(request.mock.calls.length, 1);
});

// regression: a failure was cached, so every later request rejected without retrying
test('a failed request rejects and the next call retries', async () => {
	const state = create_state();
	await assert_rejects(
		() => request_access(state, () => Promise.reject(new Error('denied'))),
		/denied/
	);
	const access = create_access();
	assert.strictEqual(await request_access(state, () => Promise.resolve(access)), access);
	assert.strictEqual(state.midi_access, access);
});

test('a reset discards a request still pending', async () => {
	const state = create_state();
	let resolve_first!: (access: MIDIAccess) => void;
	const first = request_access(state, () => new Promise((r) => (resolve_first = r)));
	reset_midi_access(state);
	const second_access = create_access();
	const second = request_access(state, () => Promise.resolve(second_access));
	resolve_first(create_access());
	assert.strictEqual(await first, second_access);
	assert.strictEqual(await second, second_access);
	assert.strictEqual(state.midi_access, second_access);
});

// mirrors InitMidiButton's click flow: a rejected authorization is surfaced and forgotten,
// so clicking again starts a fresh request that can succeed and replace the error state
test('after a failed authorization the button flow can reset, retry, and succeed', async () => {
	const state = create_state();
	const denied = vi.fn(() => Promise.reject(new Error('permission denied')));
	const granted = vi.fn(() => Promise.resolve(create_access()));

	await assert_rejects(
		async () => {
			reset_midi_access(state);
			await request_access(state, denied);
		},
		/permission denied/
	);
	assert.strictEqual(state.midi_access, null);

	const access = create_access();
	granted.mockImplementation(() => Promise.resolve(access));
	reset_midi_access(state);
	assert.strictEqual(await request_access(state, granted), access);
	assert.strictEqual(state.midi_access, access);
	assert.strictEqual(denied.mock.calls.length, 1);
	assert.strictEqual(granted.mock.calls.length, 1);

	// once granted, later clicks reuse the access instead of requesting again
	assert.strictEqual(await request_access(state, granted), access);
	assert.strictEqual(granted.mock.calls.length, 1);
});

// a browser without WebMIDI makes `request_midi_access` throw, which `request_access` must not swallow
test('an unsupported browser rejects with the readable error intact', async () => {
	const state = create_state();
	const unsupported = vi.fn(() => Promise.reject(new Error('MIDI is not supported in this browser')));
	await assert_rejects(() => request_access(state, unsupported), /not supported/);
	assert.strictEqual(state.midi_access, null);
	// the failure is forgotten, so the next call retries
	const access = create_access();
	assert.strictEqual(await request_access(state, () => Promise.resolve(access)), access);
});
