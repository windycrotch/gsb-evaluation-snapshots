// Reload coordination (last request wins, never overlapping) and the load plan (profile order -> load order).
// Self-contained: no game install, no browser — the store module only touches IndexedDB inside functions.
import { describe, expect, test } from 'bun:test';
import { createReloadCoordinator } from './reload.ts';
import { planLoad, type ModRecord, type Profile } from './store.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('reload coordinator', () => {
    test('runs requests one at a time, never overlapping', async () => {
        let active = 0, maxActive = 0, runs = 0;
        const c = createReloadCoordinator(async () => {
            runs++; active++; maxActive = Math.max(maxActive, active);
            await sleep(10);
            active--;
        });
        await c.request();
        await c.request();
        await c.request();
        expect(maxActive).toBe(1);
        expect(runs).toBe(3);
    });

    test('a burst while one is running collapses to the newest request', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        let first = true, runs = 0;
        const c = createReloadCoordinator(async () => { runs++; if (first) { first = false; await gate; } });
        const p1 = c.request();
        await sleep(0); // run #1 is now blocked inside the gate
        const p2 = c.request();
        const p3 = c.request();
        release();
        await Promise.all([p1, p2, p3]);
        expect(runs).toBe(2); // the middle request was superseded by the last one
    });

    test('the final state is the last request’s, even when requests race', async () => {
        const applied: number[] = [];
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        let first = true, current = 0;
        const c = createReloadCoordinator(async () => { if (first) { first = false; await gate; } applied.push(current); });
        current = 1; const p1 = c.request();
        await sleep(0);
        current = 2; const p2 = c.request();
        current = 3; const p3 = c.request();
        release();
        await Promise.all([p1, p2, p3]);
        expect(applied[applied.length - 1]).toBe(3);
    });

    test('a failing run does not jam the queue', async () => {
        let calls = 0;
        const c = createReloadCoordinator(async () => { calls++; if (calls === 1) throw new Error('boom'); });
        await expect(c.request()).rejects.toThrow('boom');
        await c.request();
        expect(calls).toBe(2);
    });
});

describe('load plan', () => {
    const rec = (key: string, origin: 'browser' | 'server' = 'browser'): ModRecord => ({ key, label: key, origin, zip: new Uint8Array(), stamp: '' });
    const prof = (enabled: string[], devAuto = false): Profile => ({ id: 'p', name: 'p', created: 0, enabled, devAuto, fsDb: 'x' });

    test('the profile’s enabled list is the load order; everything else is disabled and goes last', () => {
        const plan = planLoad(prof(['browser:b', 'browser:a']), [rec('browser:a'), rec('browser:b'), rec('browser:c')]);
        expect(plan.map(x => [x.rec.key, x.disabled, x.orderHint])).toEqual([
            ['browser:a', false, 1],
            ['browser:b', false, 0],
            ['browser:c', true, 4],
        ]);
    });

    test('dev-folder mods follow the profile’s own order when devAuto is on', () => {
        const plan = planLoad(prof(['browser:a'], true), [rec('browser:a'), rec('server:dev', 'server')]);
        expect(plan.find(x => x.rec.key === 'server:dev')).toMatchObject({ disabled: false, orderHint: 2 });
    });

    test('dev-folder mods stay disabled without devAuto', () => {
        const plan = planLoad(prof([]), [rec('server:dev', 'server')]);
        expect(plan[0]).toMatchObject({ disabled: true });
    });
});
