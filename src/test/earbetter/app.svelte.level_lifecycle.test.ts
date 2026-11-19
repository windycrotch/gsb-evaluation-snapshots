import * as s from '@fuzdev/fuz_schema/schema.ts';
import { test, assert, vi, beforeEach, afterEach } from 'vitest';

import {
	DEFAULT_FEEDBACK_DURATION,
	DEFAULT_NOTE_DURATION,
	LevelData
} from '#lib/earbetter/level.svelte.ts';
import { ProjectData } from '#lib/earbetter/project.ts';
import type { App } from '#lib/earbetter/app.svelte.ts';
import { create_memory_storage } from '../test_helpers.ts';
import { create_app } from './app_test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

let app: App;

beforeEach(() => {
	vi.stubGlobal('localStorage', create_memory_storage());
	vi.useFakeTimers();
	app = create_app();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/**
 * Plays the active level through its prompt to `waiting_for_input`.
 */
const finish_prompt = async (): Promise<void> => {
	assert.strictEqual(app.level!.status, 'presenting_prompt');
	await vi.advanceTimersByTimeAsync(
		DEFAULT_NOTE_DURATION * app.level!.trial!.sequence.length
	);
	assert.strictEqual(app.level!.status, 'waiting_for_input');
};

const guess_all = (): void => {
	for (const note of app.level!.trial!.sequence) app.level!.guess(note);
};

/**
 * Plays every trial of the active level to completion.
 */
const play_to_completion = async (): Promise<void> => {
	const trial_count = app.level!.level_data.trial_count;
	for (let i = 0; i < trial_count; i++) {
		await finish_prompt();
		guess_all();
		await vi.advanceTimersByTimeAsync(DEFAULT_FEEDBACK_DURATION);
	}
	assert.strictEqual(app.level!.status, 'complete');
};

test('switching the active level cancels the previous level mid-prompt', async () => {
	const first = s.parse_or_throw(LevelData, { id: 'first', trial_count: 1, sequence_length: 2 });
	const second = s.parse_or_throw(LevelData, { id: 'second', trial_count: 1, sequence_length: 2 });
	app.set_active_level_data(first);
	const previous = app.level!;
	app.level!.start();
	const seq_id = previous.seq_id;
	app.set_active_level_data(second);
	assert.strictEqual(app.level!.level_data.id, 'second');
	assert.ok(previous.seq_id > seq_id, 'the previous level is cancelled on switch');
	// the stale prompt timer of the disposed level never touches the new level
	await vi.advanceTimersByTimeAsync(DEFAULT_NOTE_DURATION * 4);
	assert.strictEqual(app.level!.status, 'initial');
	assert.strictEqual(app.level!.trial, null);
});

test('clearing the active level cancels its prompt and pending feedback', async () => {
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.level!.start();
	const previous = app.level!;
	app.set_active_level_data(null);
	assert.strictEqual(app.level, null);
	assert.strictEqual(previous.feedback_timeout, undefined);
	await vi.advanceTimersByTimeAsync(DEFAULT_NOTE_DURATION * 4);
	assert.strictEqual(app.level, null);
});

test('a level completed after it was exited never writes stats', async () => {
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.level!.start();
	await finish_prompt();
	guess_all();
	assert.strictEqual(app.level!.status, 'showing_success_feedback');
	app.set_active_level_data(null); // leave the page mid-feedback
	await vi.advanceTimersByTimeAsync(DEFAULT_FEEDBACK_DURATION * 2);
	assert.strictEqual(app.selected_project_data!.level_stats.mistakes[data.id], undefined);
});

test('a completed level records its stats exactly once', async () => {
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.level!.start();
	await play_to_completion();
	// the completion callback fires once even if completion logic runs again
	app.level!.complete_level();
	assert.deepEqual(app.selected_project_data!.level_stats.mistakes[data.id], [0]);
});

test('an unplayable active level never starts or scores', () => {
	const data = s.parse_or_throw(LevelData, {
		id: 'unplayable',
		intervals: [24],
		tonics: null,
		min_note: 48,
		max_note: 60
	});
	app.set_active_level_data(data);
	assert.ok(app.level!.error);
	app.level!.start();
	app.level!.win();
	assert.strictEqual(app.level!.status, 'initial');
	assert.strictEqual(app.selected_project_data!.level_stats.mistakes.unplayable, undefined);
});

test('removing the active level from its project blocks late scoring', () => {
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.remove_level(data.id);
	// a stale completion callback from the still-mounted level can't score a deleted level
	app.level!.complete_level();
	assert.strictEqual(app.selected_project_data!.level_stats.mistakes[data.id], undefined);
});

test('register_success ignores a level that is no longer active', () => {
	const active = app.levels![0]!;
	const other = app.levels![1]!;
	app.set_active_level_data(active);
	app.register_success(other.id, 3);
	assert.strictEqual(app.selected_project_data!.level_stats.mistakes[other.id], undefined);
	app.register_success(active.id, 2);
	assert.deepEqual(app.selected_project_data!.level_stats.mistakes[active.id], [2]);
});

test('reset during success feedback leaves only one run recorded', async () => {
	const data = s.parse_or_throw(LevelData, { id: 'reset-race', trial_count: 3 });
	app.set_active_level_data(data);
	app.level!.start();
	await finish_prompt();
	guess_all();
	assert.strictEqual(app.level!.status, 'showing_success_feedback');
	app.level!.reset();
	await vi.advanceTimersByTimeAsync(DEFAULT_FEEDBACK_DURATION * 2);
	assert.strictEqual(app.level!.trials.length, 1);
	assert.strictEqual(app.level!.trial?.index, 0);
	assert.strictEqual(
		app.selected_project_data!.level_stats.mistakes['reset-race'],
		undefined
	);
});

test('a prompt in progress when the level is replaced never advances the new level', async () => {
	const first = s.parse_or_throw(LevelData, { id: 'a', trial_count: 1, sequence_length: 2 });
	const second = s.parse_or_throw(LevelData, { id: 'b', trial_count: 1, sequence_length: 2 });
	app.set_active_level_data(first);
	app.level!.start();
	await vi.advanceTimersByTimeAsync(DEFAULT_NOTE_DURATION); // one note of the prompt
	app.set_active_level_data(second);
	await vi.advanceTimersByTimeAsync(DEFAULT_NOTE_DURATION * 6);
	assert.strictEqual(app.level!.level_data.id, 'b');
	assert.strictEqual(app.level!.status, 'initial');
	assert.strictEqual(app.level!.trials.length, 0);
});

test('the full happy path records one score on the selected project', async () => {
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.level!.start();
	await play_to_completion();
	assert.deepEqual(app.selected_project_data!.level_stats.mistakes[data.id], [0]);
});

test('a project rewritten by another tab without the active level clears it', () => {
	const project = app.selected_project_data!;
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	const rewritten = s.parse_or_throw(ProjectData, {
		...project,
		realms: project.realms.map((realm) => ({
			...realm,
			levels: realm.levels.filter((level) => level.id !== data.id)
		}))
	});
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.active_level_data, null);
	assert.strictEqual(app.level, null);
});

test('a project rewritten without the selected realm reselects consistently', () => {
	const project = app.selected_project_data!;
	const realm = app.selected_realm_data!;
	const rewritten: ProjectData = {
		...project,
		realms: project.realms.filter((r) => r.id !== realm.id)
	};
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.selected_realm_id, rewritten.realms[0]!.id);
	assert.ok(app.selected_realm_data);
});

test('removing the selected project in another tab clears the active level and selection', () => {
	const project = app.selected_project_data!;
	const data = app.levels![0]!;
	app.set_active_level_data(data);
	app.receive_storage(project.id, null);
	assert.strictEqual(app.selected_project_id, app.project_datas[0]?.id ?? null);
	assert.strictEqual(app.active_level_data, null);
	assert.strictEqual(app.level, null);
	if (app.project_datas.length === 0) assert.strictEqual(app.selected_realm_id, null);
});

test('removing the last project in another tab leaves no dangling references', () => {
	const project = app.selected_project_data!;
	for (const extra of app.project_datas.filter((p) => p.id !== project.id)) {
		app.receive_storage(extra.id, null);
	}
	app.set_active_level_data(app.levels![0]!);
	app.receive_storage(project.id, null);
	assert.strictEqual(app.project_datas.length, 0);
	assert.strictEqual(app.selected_project_id, null);
	assert.strictEqual(app.selected_realm_id, null);
	assert.strictEqual(app.active_level_data, null);
	assert.strictEqual(app.level, null);
});

test('setting the same active level data is a no-op', () => {
	const data = s.parse_or_throw(LevelData, {});
	app.set_active_level_data(data);
	const level = app.level;
	app.set_active_level_data(data);
	assert.strictEqual(app.level, level);
});
