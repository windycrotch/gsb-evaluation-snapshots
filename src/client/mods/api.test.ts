// A reload ends one mod session and starts another: hooks, event subscriptions, plugin commands and mod
// settings from the old session must be gone, and game-event wrappers must not stack.
import { describe, expect, test } from 'bun:test';
import { all } from '../settings/registry.ts';
import { OmoriMod, installGameEvents, resetModSession } from './api.ts';

describe('mod session teardown', () => {
    test('hooks are undone by resetModSession', () => {
        const target = { greet() { return 'hi'; } };
        OmoriMod.scope('t-hook').hook(target, 'greet', orig => `hooked ${orig()}`);
        expect(target.greet()).toBe('hooked hi');
        resetModSession();
        expect(target.greet()).toBe('hi');
    });

    test('event subscriptions do not survive a reset', () => {
        let n = 0;
        OmoriMod.scope('t-ev').on('t:event', () => n++);
        OmoriMod.emit('t:event');
        resetModSession();
        OmoriMod.emit('t:event');
        expect(n).toBe(1);
    });

    test('a new session can subscribe again (no double-fire with the old one)', () => {
        let a = 0, b = 0;
        OmoriMod.scope('t-old').on('t:swap', () => a++);
        resetModSession();
        OmoriMod.scope('t-new').on('t:swap', () => b++);
        OmoriMod.emit('t:swap');
        expect([a, b]).toEqual([0, 1]);
        resetModSession();
    });

    test('plugin commands are removed and the game’s original handler is restored', () => {
        const calls: string[] = [];
        (globalThis as any).Game_Interpreter = class { pluginCommand(cmd: string) { calls.push('orig:' + cmd); } };
        OmoriMod.scope('t-cmd').command('MYCMD', () => calls.push('mod'));
        const gi = new (globalThis as any).Game_Interpreter();
        gi.pluginCommand('MYCMD', []);
        resetModSession();
        gi.pluginCommand('MYCMD', []);
        expect(calls).toEqual(['mod', 'orig:MYCMD']);
        delete (globalThis as any).Game_Interpreter;
    });

    test('mod settings leave the registry on reset', () => {
        OmoriMod.scope('t-settings').settings.add({ id: 's1', label: 'S', type: 'toggle', default: false });
        expect(all().some(s => s.id === 't-settings.s1')).toBe(true);
        resetModSession();
        expect(all().some(s => s.id === 't-settings.s1')).toBe(false);
    });

    test('game events are not double-wrapped when installed again after a reload', () => {
        const sm: any = { goto(cls: unknown) { return cls; } };
        (globalThis as any).SceneManager = sm;
        installGameEvents();
        installGameEvents(); // a reload installs again: still one wrapper
        let n = 0;
        OmoriMod.scope('t-ge').on('scene:goto', () => n++);
        sm.goto({});
        expect(n).toBe(1);
        resetModSession();
        delete (globalThis as any).SceneManager;
    });
});
