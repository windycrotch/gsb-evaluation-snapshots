// The session switch itself: committing a freshly built engine must replace the running one wholesale —
// the old session's hooks vanish, the new mod set drives the file layer, and the mod list the UI shows follows.
import { describe, expect, test } from 'bun:test';
import { ModEngine } from '../../mods/engine.ts';
import { memTree } from '../../mods/vfs.ts';
import { fs } from '../shim/fs.ts';
import { OmoriMod, modInfo } from './api.ts';
import { applySession, engine } from './runtime.ts';

const KEY = '0123456789abcdef0123456789abcdef';
const te = new TextEncoder(), td = new TextDecoder();
const tree = (files: Record<string, string>) => memTree(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, te.encode(v)])));
const modTree = (id: string, files: Record<string, string> = {}) => tree({ 'mod.json': `{"id":"${id}","name":"${id}"}`, ...files });

// The game server is not running here: every plain file 404s, listings are empty.
class FakeXHR {
    status = 0;
    responseText = '';
    private url = '';
    open(_method: string, url: string) { this.url = url; }
    overrideMimeType() {}
    send() {
        if (this.url.startsWith('/__ls')) { this.status = 200; this.responseText = '[]'; }
        else this.status = 404;
    }
}
(globalThis as any).XMLHttpRequest = FakeXHR;

const build = (sources: { label: string; id: string; files?: Record<string, string>; disabled?: boolean; orderHint?: number }[]) => {
    const e = new ModEngine(() => KEY);
    e.load(sources.map(s => ({ label: s.label, tree: modTree(s.id, s.files), disabled: s.disabled, orderHint: s.orderHint })));
    return e;
};

/** Read an encrypted game file through the fs shim and decrypt it with the running engine. */
const readGameFile = (p: string) => td.decode(engine.decrypt(new Uint8Array(fs.readFileSync(p) as Uint8Array)));

describe('session switch', () => {
    test('committing a new session replaces the engine, undoes old hooks, and swaps the file layer', () => {
        const target = { f() { return 1; } };
        OmoriMod.scope('old-mod').hook(target, 'f', () => 2);
        expect(target.f()).toBe(2);

        const next = build([{ label: 'a', id: 'a-mod', files: { 'files/data/Hello.json': '{"hello":"world"}' } }]);
        applySession(next);

        expect(engine).toBe(next); // the running engine is the new one
        expect(target.f()).toBe(1); // the old session's hook is gone
        expect(modInfo.map(m => m.id)).toEqual(['a-mod']); // the UI's mod list follows
        expect(readGameFile('data/Hello.KEL')).toBe('{"hello":"world"}'); // the file layer serves the new session
    });

    test('a mod disabled in the new configuration leaves no trace in the file layer', () => {
        const on = build([{ label: 'b', id: 'b-mod', files: { 'files/data/Gone.json': '{}' } }]);
        applySession(on);
        expect(readGameFile('data/Gone.KEL')).toBe('{}');
        expect(fs.readdirSync('data')).toEqual(['Gone.KEL']);

        const off = build([{ label: 'b', id: 'b-mod', files: { 'files/data/Gone.json': '{}' }, disabled: true }]);
        applySession(off);
        expect(() => fs.readFileSync('data/Gone.KEL')).toThrow(/ENOENT/); // disabled mod's file is gone
        expect(fs.readdirSync('data')).toEqual([]); // and no stale directory listing
        expect(modInfo.find(m => m.id === 'b-mod')!.enabled).toBe(false);
    });

    test('a broken mod in the new session is disabled with a recorded reason; the rest still apply', () => {
        const e = new ModEngine(() => KEY);
        e.load([
            { label: 'broken', tree: tree({ 'mod.json': '{ nope', 'files/data/Z.json': '{}' }) },
            { label: 'ok', tree: modTree('ok-mod', { 'files/data/Ok.json': '{"ok":1}' }) },
        ]);
        applySession(e);
        expect(modInfo.find(m => m.id === 'broken')!.enabled).toBe(false);
        expect(e.diagnostics.some(d => d.level === 'error')).toBe(true);
        expect(readGameFile('data/Ok.KEL')).toBe('{"ok":1}');
    });
});
