// The player-facing load summary: which mods the engine actually runs, in which order, and why the rest do not run.
import { describe, expect, test } from 'bun:test';
import { ModEngine } from './engine.ts';
import { memTree } from './vfs.ts';

const te = new TextEncoder();
const tree = (files: Record<string, string>) => memTree(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, te.encode(v)])));
const modTree = (id: string, extra: object = {}, files: Record<string, string> = {}) =>
    tree({ 'mod.json': JSON.stringify({ id, name: `${id} display`, version: '1.2.3', ...extra }), ...files });
const mk = () => new ModEngine(() => '0123456789abcdef0123456789abcdef');

describe('load summary', () => {
    test('a dependency chain is listed in the order the engine applies it', () => {
        const e = mk();
        e.load([
            { label: 'c', tree: modTree('c-mod', { dependencies: ['b-mod'] }) },
            { label: 'a', tree: modTree('a-mod') },
            { label: 'b', tree: modTree('b-mod', { dependencies: ['a-mod'] }) },
        ]);
        const s = e.loadSummary;
        expect(s.enabled.map(m => m.id)).toEqual(['a-mod', 'b-mod', 'c-mod']);
        expect(s.enabled.map(m => m.order)).toEqual([1, 2, 3]);
        expect(s.enabled[0]).toMatchObject({ id: 'a-mod', name: 'a-mod display', version: '1.2.3', origin: 'a' });
        expect(s.disabled).toEqual([]);
        expect(s.counts).toEqual({ total: 3, enabled: 3, disabled: 0, conflicts: 0 });
        // the summary agrees with what the rest of the engine resolves
        expect(s.enabled.map(m => m.id)).toEqual(e.activeMods().map(m => m.id));
    });

    test('a mod whose dependency is missing is left out and says so', () => {
        const e = mk();
        e.load([
            { label: 'needy', tree: modTree('needy-mod', { dependencies: ['nowhere-mod'] }) },
            { label: 'fine', tree: modTree('fine-mod') },
        ]);
        const s = e.loadSummary;
        expect(s.enabled.map(m => m.id)).toEqual(['fine-mod']);
        const off = s.disabled.find(m => m.id === 'needy-mod')!;
        expect(off.reason.kind).toBe('missing-dependency');
        expect(off.reason.mods).toEqual(['nowhere-mod']);
        expect(off.reason.message).toContain('not installed');
        expect(s.counts).toEqual({ total: 2, enabled: 1, disabled: 1, conflicts: 0 });
        expect(e.activeMods().some(m => m.id === 'needy-mod')).toBe(false);
    });

    test('a dependency that is switched off counts as missing, and the reason names it', () => {
        const e = mk();
        e.load([
            { label: 'base', tree: modTree('base-mod'), disabled: true },
            { label: 'user', tree: modTree('user-mod', { dependencies: ['base-mod'] }) },
        ]);
        const s = e.loadSummary;
        expect(s.enabled).toEqual([]);
        expect(s.disabled.find(m => m.id === 'base-mod')!.reason.kind).toBe('user-disabled');
        const dependent = s.disabled.find(m => m.id === 'user-mod')!;
        expect(dependent.reason.kind).toBe('missing-dependency');
        expect(dependent.reason.message).toContain('disabled');
    });

    test('every mod in a dependency cycle is disabled, none of them is listed as enabled', () => {
        const e = mk();
        e.load([
            { label: 'a', tree: modTree('a-mod', { dependencies: ['b-mod'] }) },
            { label: 'b', tree: modTree('b-mod', { dependencies: ['a-mod'] }) },
            { label: 'self', tree: modTree('self-mod', { dependencies: ['self-mod'] }) },
            { label: 'ok', tree: modTree('ok-mod') },
        ]);
        const s = e.loadSummary;
        expect(s.enabled.map(m => m.id)).toEqual(['ok-mod']);
        const kinds = Object.fromEntries(s.disabled.map(m => [m.id, m.reason.kind]));
        expect(kinds).toEqual({ 'a-mod': 'dependency-cycle', 'b-mod': 'dependency-cycle', 'self-mod': 'dependency-cycle' });
        const cycle = s.disabled.find(m => m.id === 'a-mod')!;
        expect(new Set(cycle.reason.mods)).toEqual(new Set(['a-mod', 'b-mod']));
        expect(cycle.reason.message).toContain('a-mod -> b-mod');
    });

    test('an excludes clash only warns: both mods stay enabled and both are listed', () => {
        const e = mk();
        // excludes is a OneLoader field, so these use that manifest dialect (manifestVersion + files)
        e.load([
            { label: 'a', tree: modTree('a-mod', { manifestVersion: 1, files: {}, excludes: ['b-mod'] }) },
            { label: 'b', tree: modTree('b-mod', { manifestVersion: 1, files: {} }) },
        ]);
        const s = e.loadSummary;
        expect(s.enabled.map(m => m.id).sort()).toEqual(['a-mod', 'b-mod']);
        expect(s.conflicts).toHaveLength(1);
        expect(s.conflicts[0]).toMatchObject({ kind: 'declared-conflict', mod: 'a-mod', target: 'b-mod', others: ['b-mod'] });
        expect(s.counts.conflicts).toBe(1);
        expect(e.activeMods()).toHaveLength(2);
        expect(e.diagnostics.some(d => d.level === 'warn' && /conflicts with "b-mod"/.test(d.message))).toBe(true);
    });

    test('a duplicate id disables the later copy, with a reason naming the first', () => {
        const e = mk();
        e.load([
            { label: 'first', tree: modTree('twin-mod') },
            { label: 'second', tree: modTree('twin-mod') },
        ]);
        const s = e.loadSummary;
        expect(s.enabled.map(m => `${m.id}@${m.origin}`)).toEqual(['twin-mod@first']);
        const off = s.disabled.find(m => m.origin === 'second')!;
        expect(off.reason.kind).toBe('duplicate-id');
        expect(off.reason.message).toContain('first');
    });

    test('reloading replaces the summary, so it always describes the current set', () => {
        const e = mk();
        e.load([
            { label: 'a', tree: modTree('a-mod', { dependencies: ['b-mod'] }) },
            { label: 'b', tree: modTree('b-mod') },
        ]);
        expect(e.loadSummary.enabled.map(m => m.id)).toEqual(['b-mod', 'a-mod']);
        e.load([{ label: 'a', tree: modTree('a-mod', { dependencies: ['b-mod'] }) }]);
        expect(e.loadSummary.enabled).toEqual([]);
        expect(e.loadSummary.disabled.map(m => [m.id, m.reason.kind])).toEqual([['a-mod', 'missing-dependency']]);
        expect(e.loadSummary.version).toBe(e.version);
    });

    test('loadAfter only orders; a loadAfter loop is a warning, not a disable', () => {
        const e = mk();
        e.load([
            { label: 'b', tree: modTree('b-mod', { loadAfter: ['a-mod'] }) },
            { label: 'a', tree: modTree('a-mod', { loadAfter: ['b-mod'] }) },
        ]);
        const s = e.loadSummary;
        expect(s.enabled).toHaveLength(2);
        expect(s.disabled).toEqual([]);
        expect(e.diagnostics.some(d => d.level === 'warn' && /ordering cycle/.test(d.message))).toBe(true);
    });

    test('a mod disabled by a OneLoader "requires" also disables its dependents, in one load', () => {
        const e = mk();
        e.load([
            // ol needs a requirement that is missing, so it is disabled; native then depends on "ol"
            { label: 'ol', tree: modTree('ol-mod', { manifestVersion: 1, files: {}, requires: ['absent-mod'] }) },
            { label: 'nat', tree: modTree('nat-mod', { dependencies: ['ol-mod'] }) },
        ]);
        const s = e.loadSummary;
        expect(s.enabled).toEqual([]);
        expect(Object.fromEntries(s.disabled.map(m => [m.id, m.reason.kind]))).toEqual({
            'ol-mod': 'missing-dependency', 'nat-mod': 'missing-dependency',
        });
        expect(s.disabled.find(m => m.id === 'nat-mod')!.reason.message).toContain('ol-mod');
    });

    test('a mod with a broken manifest is disabled with its manifest error as the reason', () => {
        const e = mk();
        e.load([{ label: 'broken', tree: tree({ 'mod.json': JSON.stringify({ id: 'Bad Id', name: 'x' }) }) }]);
        const off = e.loadSummary.disabled.find(m => m.id === 'Bad Id')!;
        expect(off.reason.kind).toBe('invalid-manifest');
        expect(off.reason.message).toContain('"id" must match');
    });
});
