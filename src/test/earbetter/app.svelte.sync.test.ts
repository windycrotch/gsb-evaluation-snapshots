import * as s from '@fuzdev/fuz_schema/schema.ts';
import { test, assert, vi, beforeEach, afterEach } from 'vitest';

import { LevelData } from '#lib/earbetter/level.svelte.ts';
import { ProjectData } from '#lib/earbetter/project.ts';
import { create_memory_storage } from '../test_helpers.ts';
import {
	create_app,
	read_stored,
	TEST_SITE_STORAGE_KEY,
	TEST_STORAGE_KEY
} from './app_test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

beforeEach(() => {
	vi.stubGlobal('localStorage', create_memory_storage());
});
afterEach(() => {
	vi.unstubAllGlobals();
});

test('applies site settings from another tab without writing back', () => {
	const app = create_app();
	app.volume = 0.5;
	const stored = read_stored(TEST_SITE_STORAGE_KEY);
	app.receive_storage(TEST_SITE_STORAGE_KEY, JSON.stringify({ ...stored, volume: 0.1 }));
	assert.strictEqual(app.volume, 0.1);
	assert.strictEqual(read_stored(TEST_SITE_STORAGE_KEY).volume, 0.5);
});

test('keeps its own selection when app data arrives from another tab', () => {
	const app = create_app();
	const realm = app.realms![1]!;
	app.select_realm(realm.id);
	const project_id = app.selected_project_id;
	app.receive_storage(
		TEST_STORAGE_KEY,
		JSON.stringify({
			...app.app_data,
			show_trainer_help: false,
			selected_project_id: null,
			selected_realm_id: null
		})
	);
	assert.strictEqual(app.show_trainer_help, false);
	assert.strictEqual(app.selected_project_id, project_id);
	assert.strictEqual(app.selected_realm_id, realm.id);
});

test('updates a loaded project edited in another tab', () => {
	const app = create_app();
	const project = app.project_datas[0]!;
	app.receive_storage(project.id, JSON.stringify({ ...project, name: 'renamed' }));
	assert.strictEqual(app.selected_project_data?.name, 'renamed');
});

test('drops a loaded project removed in another tab and reselects', () => {
	const app = create_app();
	const other = s.parse_or_throw(ProjectData, { name: 'other' });
	app.create_project(other);
	app.receive_storage(other.id, null);
	assert.ok(!app.project_datas.some((p) => p.id === other.id));
	assert.strictEqual(app.selected_project_id, app.project_datas[0]!.id);
});

test('ignores unloaded projects, cleared storage, and invalid values', () => {
	const app = create_app();
	const before = app.project_datas;
	const site_data = app.site_data;
	app.receive_storage('unknown_project', JSON.stringify({}));
	app.receive_storage(null, null);
	app.receive_storage(TEST_SITE_STORAGE_KEY, '{not json');
	app.receive_storage(TEST_SITE_STORAGE_KEY, JSON.stringify({ volume: 'loud' }));
	assert.strictEqual(app.project_datas, before);
	assert.strictEqual(app.site_data, site_data);
});

test('removing the selected project in another tab clears an in-progress level', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const mounted = app.level!;
	app.receive_storage(project.id, null);
	assert.strictEqual(app.active_level_data, null);
	assert.strictEqual(app.level, null);
	assert.ok(mounted.seq_id > 0, 'the disposed level had its prompt cancelled');
});

test('a rewritten project that drops the active level clears it and reselects a realm', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const level = app.levels![0]!;
	const realm = app.selected_realm_data!;
	app.set_active_level_data(level);
	const rewritten: ProjectData = {
		...project,
		realms: project.realms.map((r) =>
			r.id === realm.id
				? { ...r, levels: r.levels.filter((l) => l.id !== level.id) }
				: r
		)
	};
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.active_level_data, null);
	assert.strictEqual(app.level, null);
	// the selected realm still exists, so it is kept
	assert.strictEqual(app.selected_realm_id, realm.id);
});

test('a rewritten project that drops the selected realm falls back to its first realm', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const realm = app.selected_realm_data!;
	const rewritten: ProjectData = {
		...project,
		realms: project.realms.filter((r) => r.id !== realm.id)
	};
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.selected_realm_id, rewritten.realms[0]!.id);
	assert.deepEqual(app.selected_realm_data, rewritten.realms[0]!);
});

test('a rewritten project that removes every realm clears the realm selection', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const rewritten: ProjectData = { ...project, realms: [] };
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.selected_realm_id, null);
	assert.strictEqual(app.levels, null);
});

test('a level removed in another tab cannot score after the rewrite', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const rewritten: ProjectData = {
		...project,
		realms: project.realms.map((r) => ({
			...r,
			levels: r.levels.filter((l) => l.id !== level.id)
		}))
	};
	app.receive_storage(project.id, JSON.stringify(rewritten));
	// the level was cleared, and even a stale callback with its id is refused
	app.register_success(level.id, 0);
	assert.strictEqual(app.selected_project_data!.level_stats.mistakes[level.id], undefined);
});

test('an unrelated project rewrite leaves the active level untouched', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const other = s.parse_or_throw(ProjectData, { name: 'other' });
	app.create_project(other);
	app.select_project(project.id); // create_project selects the new one; go back to the original
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const mounted = app.level!;
	app.receive_storage(other.id, JSON.stringify({ ...other, name: 'renamed' }));
	assert.strictEqual(app.level, mounted);
	assert.strictEqual(app.active_level_data, level);
});

test('the active level is unaffected when a different project is removed', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const other = s.parse_or_throw(ProjectData, { name: 'other' });
	app.create_project(other);
	app.select_project(project.id); // create_project selects the new one; go back to the original
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const mounted = app.level!;
	app.receive_storage(other.id, null);
	assert.strictEqual(app.level, mounted);
	assert.strictEqual(app.active_level_data, level);
});

test('an invalid rewrite of the selected project keeps the current state', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const mounted = app.level!;
	app.receive_storage(project.id, '{not json');
	assert.strictEqual(app.level, mounted);
	assert.strictEqual(app.active_level_data, level);
	assert.strictEqual(app.selected_project_id, project.id);
});

test('a rewrite keeping the active level and realm keeps every selection', () => {
	const app = create_app();
	const project = app.selected_project_data!;
	const level = app.levels![0]!;
	app.set_active_level_data(level);
	const mounted = app.level!;
	const realm_id = app.selected_realm_id;
	const rewritten: ProjectData = { ...project, name: 'renamed' };
	app.receive_storage(project.id, JSON.stringify(rewritten));
	assert.strictEqual(app.level, mounted);
	assert.strictEqual(app.active_level_data, level);
	assert.strictEqual(app.selected_realm_id, realm_id);
	assert.strictEqual(app.selected_project_data?.name, 'renamed');
});

test('a level hash unrelated to the project still mounts but cannot score', () => {
	const app = create_app();
	const orphan = s.parse_or_throw(LevelData, { id: 'orphan', name: 'shared via url' });
	app.set_active_level_data(orphan);
	assert.strictEqual(app.level!.level_data.id, 'orphan');
	app.level!.win(); // completing it must not write stats for a level the project doesn't contain
	assert.strictEqual(
		app.selected_project_data!.level_stats.mistakes.orphan,
		undefined
	);
});
