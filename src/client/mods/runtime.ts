// Mod runtime: builds the engine from installed mods, hooks it into the fs shim and service worker,
// and runs mod scripts at the right point of boot.
//
// A reload is a full session switch, not a page reload: the next session is built beside the running one
// (edit tables, caches, diagnostics, asset key, patched images), the service worker is moved over, and only
// then does the page commit — file layer, script hooks, plugin list — in one synchronous step. A failure
// anywhere before the commit leaves the previous session running.
import { ModEngine, assetKeyFromSystem, type Diagnostic, type LoadedMod } from '../../mods/engine.ts';
import type { ClientScript } from '../../mods/manifest.ts';
import { zipTreeFromBytes } from '../../mods/vfs.ts';
import { setModLayer } from '../shim/fs.ts';
import { modInfo, report, resetModSession, setCurrent } from './api.ts';
import { installModLoaderShim, runExec, type ModLoaderShim } from './compat.ts';
import { applyImageDeltas } from './olid.ts';
import { patchPluginList } from './plugins.ts';
import { createReloadCoordinator } from './reload.ts';
import { getActiveProfile, listMods, planLoad, replaceGenerated, setMeta, syncServerMods, type ModRecord, type Profile } from './store.ts';

export const SAFE_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mods') === '0';

let key = '';
const makeEngine = () => new ModEngine(() => key, (d: Diagnostic) => {
    if (d.level === 'info') return;
    // Problems found while loading mods surface in the same panel and log as runtime errors.
    report(d.mod ?? '(mods)', new Error(d.message), '', d.level === 'warn' ? 'warn' : 'error');
});
export let engine = makeEngine();
/** The mod library (every installed mod) and the profile this session runs as. */
export let records: ModRecord[] = [];
export let profile: Profile | null = null;
let shim: ModLoaderShim | null = null;

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** A small status line during startup work that can take a while (patching many images). */
function bootStatus() {
    const el = document.createElement('div');
    el.setAttribute('style', 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483200;background:#000c;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:6px;pointer-events:none');
    document.body.append(el);
    return { set: (t: string) => { el.textContent = t; }, done: () => el.remove() };
}

/** Images and audio are stored with RPG Maker's encryption; replacing one means encoding it with the game's own asset key. */
async function prepareAssetKey(e: ModEngine): Promise<void> {
    const r = await fetch('/data/System.KEL', { cache: 'no-store' });
    if (!r.ok) throw new Error('could not read the game\'s System data');
    const system = JSON.parse(new TextDecoder().decode(e.decrypt(new Uint8Array(await r.arrayBuffer()))));
    e.assetKey = assetKeyFromSystem(system);
    await setMeta('assetKey', hex(e.assetKey)); // the service worker has no game key, so it reads this
}

/**
 * Read the current profile + library and build the next mod session next to the running one.
 * Nothing the game can see changes until applySession runs, so a failure here leaves the old session playable.
 * A mod whose manifest or zip cannot be parsed is disabled with the reason recorded; the rest still load.
 */
async function buildSession(): Promise<ModEngine> {
    profile = await getActiveProfile();
    records = (await listMods()).sort((a, b) => a.key.localeCompare(b.key));
    const next = makeEngine();
    next.assetKey = engine.assetKey; // already read this boot: reuse it
    next.load(planLoad(profile, records).map(({ rec, disabled, orderHint }) => {
        try { return { label: rec.label, tree: zipTreeFromBytes(rec.zip, rec.stamp), origin: rec.key, disabled, orderHint }; }
        catch (e) { report(rec.label, e, 'not a valid zip'); return null; }
    }).filter((x): x is NonNullable<typeof x> => !!x));

    const wantsImages = () => next.activeMods().some(m => m.imageDeltas.length);
    if ((next.hasAssetEdits() || wantsImages()) && !next.assetKey) {
        try { await prepareAssetKey(next); } catch (e) {
            report('(mods)', e, 'replaced images and audio cannot be applied');
            // the mods that need the key go off with a recorded reason; everything else stays usable
            for (const m of [...next.activeMods()]) {
                if (m.imageDeltas.length || m.edits.some(x => !next.isEncrypted(x.target)))
                    next.disableMod(m.id, 'disabled: the game\'s asset key could not be read, so its image/audio replacements cannot be encoded');
            }
        }
    }
    let generated: Record<string, Uint8Array> = {};
    if (wantsImages() && next.assetKey) {
        const status = bootStatus();
        try {
            const r = await applyImageDeltas(next, (done, total, name) => status.set(`Patching images ${done}/${total}${name ? ` · ${name.split('/').pop()}` : ''}`));
            generated = r.generated;
        } finally { status.done(); }
    }
    await replaceGenerated(generated).catch(e => report('(mods)', e, 'could not save patched images'));
    return next;
}

/** Commit a built session: swap the engine, rebuild the file layer, undo the old scripts' hooks, install the new shim. */
export function applySession(next: ModEngine): void {
    engine = next;
    modInfo.splice(0, modInfo.length, ...next.mods.map(m => ({ id: m.id, name: m.name, version: m.version, enabled: m.enabled })));
    setModLayer({
        has: k => next.hasEdits(k) && next.isEncrypted(k),
        resolve: (k, base) => next.resolve(k, base),
        added: dir => next.addedNames(dir),
    });
    resetModSession(); // the old scripts' hooks, event subscriptions, commands and settings go away before new scripts run
    shim = installModLoaderShim(next.activeMods());
}

/** Load installed mods and plug them into the game's file layer. Never throws: a broken mod store means "no mods". */
export async function initMods(gameKey: string): Promise<void> {
    key = gameKey;
    try {
        profile = await getActiveProfile();
        records = (await listMods()).sort((a, b) => a.key.localeCompare(b.key));
    } catch (e) { report('(mods)', e, 'could not read profiles'); }
    if (SAFE_MODE) {
        console.warn('[mods] safe mode (?mods=0): no mods loaded');
        await syncServiceWorker(engine, true);
        return;
    }
    try {
        await syncServerMods();
        applySession(await buildSession());
    } catch (e) {
        report('(mods)', e, 'could not load the mod store');
        return;
    }
    await syncServiceWorker(engine);
}

/** The boot sequence's mod-script phases, re-run after a reload so the new session's scripts install their hooks. */
async function runModScripts(): Promise<void> {
    await runPhase('early');
    await runPhase('pre-plugins');
    patchPlugins();
    await runPhase('post-plugins');
    await runPhase('ready');
}

async function doReload(): Promise<void> {
    const next = await buildSession(); // all the fallible work; the old session is untouched if this throws
    await syncServiceWorker(next);     // the asset layer (images/audio/plain scripts) switches first...
    applySession(next);                // ...then the page side commits in one synchronous step
    await runModScripts();
}

const coordinator = createReloadCoordinator(async () => {
    try { await doReload(); }
    catch (e) { report('(mods)', e, 'reload failed; the previous mod setup is still active'); }
});

/**
 * Re-apply the current profile's mod configuration without reloading the page.
 * Safe to call at any time and more than once: calls are queued and only the newest configuration wins.
 */
export const requestModReload = (): Promise<void> => (SAFE_MODE ? Promise.resolve() : coordinator.request());

/** Images, audio and plain scripts bypass the fs shim, so a service worker serves the mod versions. */
async function syncServiceWorker(e: ModEngine, safe = false): Promise<void> {
    if (!('serviceWorker' in navigator)) {
        if (e.hasAssetEdits()) report('(mods)', new Error('this browser has no service worker support; mods that replace images/audio will not apply'), '', 'warn');
        return;
    }
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (safe) { if (existing) navigator.serviceWorker.controller?.postMessage({ type: 'reload', safe: true }); return; }
    if (!e.hasAssetEdits()) { if (existing) navigator.serviceWorker.controller?.postMessage({ type: 'reload', safe: true }); await existing?.unregister(); return; }
    try {
        const reg = existing ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await Promise.race([
                new Promise<void>(res => navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true })),
                new Promise<void>(res => setTimeout(res, 4000)),
            ]);
        }
        const sw = navigator.serviceWorker.controller ?? reg.active;
        if (!sw) throw new Error('service worker did not take control');
        await new Promise<void>((res, rej) => {
            const t = setTimeout(() => rej(new Error('service worker did not answer')), 15000);
            navigator.serviceWorker.addEventListener('message', function h(e) {
                if (e.data?.type !== 'reloaded') return;
                clearTimeout(t); navigator.serviceWorker.removeEventListener('message', h);
                e.data.error ? rej(new Error('service worker failed to read mods')) : res();
            });
            sw.postMessage({ type: 'reload' });
        });
    } catch (e) {
        report('(mods)', e, 'asset mods may not apply');
    }
}

/** Parameters OneLoader passes to scripts at each stage. */
function paramsFor(phase: ClientScript['phase']): Record<string, unknown> {
    const g = globalThis as any;
    if (phase === 'pre-plugins') return { PluginManager: g.PluginManager, $plugins: g.$plugins };
    return { knownMods: shim?.knownMods ?? new Map(), $modLoader: shim };
}

/**
 * Run every active mod's scripts for a boot phase, in load order (OneLoader scripts also in run-at order).
 * A throwing script is reported against its mod and skipped.
 */
export async function runPhase(phase: ClientScript['phase']): Promise<void> {
    const items: { mod: LoadedMod; script: NonNullable<LoadedMod['scripts']>[number]; at: number }[] = [];
    engine.activeMods().forEach((mod, at) => mod.scripts.filter(s => s.phase === phase).forEach(script => items.push({ mod, script, at })));
    items.sort((a, b) => (a.script.rank ?? 0) - (b.script.rank ?? 0) || a.at - b.at);
    for (const { mod: m, script: s } of items) {
        if (s.style === 'eval' || s.style === 'require') { await runExec(m, s.file, s.style, paramsFor(phase)); continue; }
        try {
            const code = new TextDecoder().decode(m.tree.read(s.file));
            const el = document.createElement('script');
            el.textContent = `${code}\n//# sourceURL=omori-mod://${m.id}/${s.file}`;
            setCurrent({ id: m.id, file: s.file });
            document.head.appendChild(el); // runs synchronously; errors reach the window error handler, attributed via sourceURL
            el.remove();
        } catch (e) {
            report(m.id, e, `script ${s.file} (${phase})`);
        } finally { setCurrent(null); }
    }
}

/** Add mod-provided plugins to the game's plugin list and apply plugin_parameters. Run after `pre-plugins` scripts. */
export function patchPlugins(): void {
    if (!shim) return;
    try {
        const { added } = patchPluginList((globalThis as any).$plugins, engine.activeMods(), shim);
        if (added.length) console.log(`[mods] added ${added.length} plugin(s) to the game: ${added.join(', ')}`);
    } catch (e) { report('(mods)', e, 'could not patch the plugin list'); }
}
