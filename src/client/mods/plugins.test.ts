// The plugin list patch must be exactly undoable: a reload re-runs it on the same $plugins array, and nothing
// may stack — mod plugins appear once, and plugin_parameters are always applied to the game's original values.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { LoadedMod } from '../../mods/engine.ts';
import { installModLoaderShim } from './compat.ts';
import { patchPluginList, resetPluginListState, unpatchPluginList, type Entry } from './plugins.ts';

const mod = (id: string, over: Partial<LoadedMod> = {}): LoadedMod => ({
    id, name: id, version: '1', description: '', format: 'native', dependencies: [], loadAfter: [], priority: 0,
    requires: [], excludes: [], satisfies: [], skipChecks: {}, flags: [], edits: [], scripts: [],
    pluginParameters: {}, pluginOrder: {}, pluginFiles: [], imageDeltas: [], json: null, warnings: [], errors: [],
    origin: id, enabled: true, userDisabled: false, order: 0, orderHint: 0, tree: null as never, ...over,
});

const gamePlugins = (): Entry[] => [
    { name: 'YEP_CoreEngine', status: true, description: 'game', parameters: { list: ['a'], volume: '80' } },
    { name: 'GOMORI', status: true, description: 'game', parameters: {} },
];

const names = (plugins: Entry[]) => plugins.map(p => p.name);

beforeEach(() => resetPluginListState());

describe('plugin list patching across reloads', () => {
    test('a mod plugin is added once, and re-patching does not duplicate it', () => {
        const plugins = gamePlugins();
        const m = mod('plug-mod', { pluginFiles: ['myplugin'], pluginOrder: { myplugin: { at: -1 } } });
        patchPluginList(plugins, [m], installModLoaderShim([m]));
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI', 'myplugin']);
        patchPluginList(plugins, [m], installModLoaderShim([m])); // same mods again (a reload)
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI', 'myplugin']);
    });

    test('disabling the mod removes its plugin from the list', () => {
        const plugins = gamePlugins();
        const m = mod('plug-mod', { pluginFiles: ['myplugin'], pluginOrder: { myplugin: { at: -1 } } });
        patchPluginList(plugins, [m], installModLoaderShim([m]));
        patchPluginList(plugins, [], installModLoaderShim([])); // reloaded with the mod off
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI']);
    });

    test('plugin_parameters always patch the original values, never stack', () => {
        const plugins = gamePlugins();
        const m = mod('param-mod', { pluginParameters: { YEP_CoreEngine: [{ op: 'add', path: '/list/-', value: 'x' }] } });
        patchPluginList(plugins, [m], installModLoaderShim([m]));
        expect(plugins[0]!.parameters.list).toEqual(['a', 'x']);
        patchPluginList(plugins, [m], installModLoaderShim([m]));
        expect(plugins[0]!.parameters.list).toEqual(['a', 'x']); // not ['a', 'x', 'x']
    });

    test('unpatchPluginList restores parameters and removals exactly', () => {
        const plugins = gamePlugins();
        const m = mod('param-mod', {
            pluginFiles: ['myplugin'], pluginOrder: { myplugin: { at: -1 } },
            pluginParameters: { YEP_CoreEngine: [{ op: 'replace', path: '/volume', value: '10' }] },
        });
        patchPluginList(plugins, [m], installModLoaderShim([m]));
        expect(plugins[0]!.parameters.volume).toBe('10');
        unpatchPluginList(plugins);
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI']);
        expect(plugins[0]!.parameters).toEqual({ list: ['a'], volume: '80' });
    });

    test('two mods adding different plugins both appear, in load order, without duplicates', () => {
        const plugins = gamePlugins();
        const a = mod('a-mod', { pluginFiles: ['aplugin'], pluginOrder: { aplugin: { at: -1 } } });
        const b = mod('b-mod', { pluginFiles: ['bplugin'], pluginOrder: { bplugin: { at: -1 } } });
        patchPluginList(plugins, [a, b], installModLoaderShim([a, b]));
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI', 'aplugin', 'bplugin']);
        patchPluginList(plugins, [b, a], installModLoaderShim([b, a])); // reordered on reload
        expect(names(plugins)).toEqual(['YEP_CoreEngine', 'GOMORI', 'bplugin', 'aplugin']);
    });
});
