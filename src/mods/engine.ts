// Mod engine: discovers mods, orders them, and answers "what are the bytes of game file X?" with every
// mod's edits applied. Game data is encrypted at rest, so edited files are decrypted, edited as plain
// JSON/YAML/text, then re-encrypted with the game's own key. Images and audio use RPG Maker's lighter
// scheme (a header and an XOR over the first 16 bytes), re-applied with the game's asset key.
// The game never knows a mod was involved.
import aesjs from 'aes-js';
import yaml from 'js-yaml';
import { formatOfGamePath, loadMod, type ClientScript, type Edit, type ModDef } from './manifest.ts';
import { PatchError, applyJsonPatch, applyMergePatch, applyTextPatch } from './patch.ts';
import type { Tree } from './vfs.ts';

export interface Diagnostic { level: 'error' | 'warn' | 'info'; mod?: string; file?: string; message: string; time: number }

export interface ModSource {
    /** fallback id / display label (file name without extension) */
    label: string;
    tree: Tree;
    /** where it came from, for messages: a path, "browser", "server" */
    origin?: string;
    /** user switched it off */
    disabled?: boolean;
}

/**
 * Why the engine does not load a mod. The kinds are the ones a player needs to tell apart in the load
 * summary: "I switched it off" is very different from "something it needs is missing".
 */
export type DisableReasonKind = 'user-disabled' | 'invalid-manifest' | 'duplicate-id' | 'missing-dependency' | 'dependency-cycle';

export interface DisableReason {
    kind: DisableReasonKind;
    /** a short, player-readable explanation */
    message: string;
    /** ids involved in the decision: the missing dependency, the members of a cycle, the winning duplicate */
    mods?: string[];
}

export interface LoadedMod extends ModDef {
    origin: string;
    enabled: boolean;
    /** disabled by the user, not because of an error */
    userDisabled: boolean;
    order: number;
    tree: Tree;
    /** why this mod is not enabled; undefined for enabled mods (and cleared while loading) */
    disableReason?: DisableReason;
}

/** A declared `excludes` clash between two enabled mods. A warning only: both stay enabled. */
export interface LoadConflict {
    kind: 'declared-conflict';
    /** the mod that declared the exclusion */
    mod: string;
    /** the id or satisfying alias it excludes */
    target: string;
    /** enabled mods providing that target (each stays enabled) */
    others: string[];
    message: string;
}

export interface EnabledModSummary {
    /** 1-based position in the final load order */
    order: number;
    id: string;
    name: string;
    version: string;
    origin: string;
}

export interface DisabledModSummary {
    id: string;
    name: string;
    version: string;
    origin: string;
    /** true when the player turned it off in the active profile */
    userDisabled: boolean;
    reason: DisableReason;
}

/**
 * A player-facing snapshot of one mod load: enabled mods in the order the engine actually applies them,
 * disabled mods with a reason each, and declared conflicts that were downgraded to warnings.
 * Refreshed by `ModEngine.load()`, so it always matches what the engine resolved.
 */
export interface LoadSummary {
    /** engine version this snapshot belongs to (incremented on every load) */
    version: number;
    enabled: EnabledModSummary[];
    disabled: DisabledModSummary[];
    conflicts: LoadConflict[];
    counts: { total: number; enabled: number; disabled: number; conflicts: number };
}

const dec = new TextDecoder(), enc = new TextEncoder();
const BOM = /^﻿/;

/** RPG Maker MV's encrypted-asset header: "RPGMV" + version + padding. */
const RPG_HEADER = new Uint8Array([0x52, 0x50, 0x47, 0x4d, 0x56, 0, 0, 0, 0x00, 0x03, 0x01, 0, 0, 0, 0, 0]);

/** The asset key is stored in the game's (encrypted) System data as 32 hex digits. */
export function assetKeyFromSystem(systemJson: { encryptionKey?: string }): Uint8Array {
    const hex = systemJson.encryptionKey ?? '';
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

export class ModEngine {
    mods: LoadedMod[] = [];
    diagnostics: Diagnostic[] = [];
    version = 0;
    /** What the last `load()` decided, in the player's terms. Rebuilt on every load, so it always matches `activeMods()`. */
    loadSummary: LoadSummary = {
        version: 0, enabled: [], disabled: [], conflicts: [],
        counts: { total: 0, enabled: 0, disabled: 0, conflicts: 0 },
    };
    /** set by the host once it has read the game's System data; needed to encode replaced images and audio */
    assetKey: Uint8Array | null = null;
    private edits = new Map<string, { mod: LoadedMod; edit: Edit }[]>(); // lowercase game path -> ordered edits
    private generated = new Map<string, Uint8Array>(); // finished bytes made by other code (patched images)
    private cache = new Map<string, { sig: string; bytes: Uint8Array }>();
    /** declared `excludes` clashes found by the load in progress (published through `loadSummary`) */
    private lastConflicts: LoadConflict[] = [];

    constructor(
        private getKey: () => string | null = () => null,
        private onLog?: (d: Diagnostic) => void,
    ) {}

    // ------------------------------------------------------------ logging
    log(level: Diagnostic['level'], message: string, extra: Partial<Diagnostic> = {}) {
        const d: Diagnostic = { level, message, time: Date.now(), ...extra };
        this.diagnostics.push(d);
        if (this.diagnostics.length > 500) this.diagnostics.shift();
        this.onLog?.(d);
    }

    // ------------------------------------------------------------ loading
    /** Replace the active mod set. Invalid mods stay in `mods` (disabled, with their errors) so a UI can show why. */
    load(sources: ModSource[]) {
        this.version++;
        this.mods = []; this.edits.clear(); this.cache.clear(); this.generated.clear();
        this.diagnostics = [];
        this.lastConflicts = [];
        this.loadSummary = { version: this.version, enabled: [], disabled: [], conflicts: [], counts: { total: 0, enabled: 0, disabled: 0, conflicts: 0 } };

        const found: LoadedMod[] = [];
        const unreadable: DisabledModSummary[] = [];
        for (const src of sources) {
            try {
                const def = loadMod(src.tree, src.label);
                found.push({ ...def, origin: src.origin ?? src.label, enabled: !src.disabled, userDisabled: !!src.disabled, order: 0, tree: src.tree });
            } catch (e) {
                const why = (e as Error).message;
                this.log('error', `cannot read mod "${src.label}": ${why}`, { mod: src.label });
                unreadable.push({
                    id: src.label, name: src.label, version: '?', origin: src.origin ?? src.label, userDisabled: !!src.disabled,
                    reason: { kind: 'invalid-manifest', message: `cannot read this mod: ${why}` },
                });
            }
        }
        for (const m of found) {
            for (const w of m.warnings) this.log('warn', w, { mod: m.id });
            for (const e of m.errors) this.log('error', e, { mod: m.id });
            if (m.userDisabled) {
                m.enabled = false;
                m.disableReason = { kind: 'user-disabled', message: 'switched off in this profile' };
                continue;
            }
            if (m.errors.length) {
                m.enabled = false;
                m.disableReason = { kind: 'invalid-manifest', message: `mod.json cannot be loaded: ${m.errors.join('; ')}` };
            }
        }
        this.order(found);
        // `requires` can disable a mod that others list in `dependencies`; re-settle ordering until nothing changes
        for (;;) {
            const before = found.filter(m => m.enabled).length;
            this.checkCompatibility(found);
            if (found.filter(m => m.enabled).length === before) break;
            this.order(found);
        }
        this.collectConflicts(found);
        // compatibility can disable mods after ordering; keep order numbers dense
        found.filter(m => m.enabled).sort((a, b) => a.order - b.order).forEach((m, i) => (m.order = i));
        this.mods = found;
        for (const m of this.activeMods()) {
            for (const edit of m.edits) {
                const k = edit.target.toLowerCase();
                (this.edits.get(k) ?? this.edits.set(k, []).get(k)!).push({ mod: m, edit });
            }
        }
        this.detectConflicts();
        this.loadSummary = this.buildSummary(found, unreadable);
        const on = this.mods.filter(m => m.enabled);
        this.log('info', `${on.length} mod(s) active${on.length ? ': ' + on.map(m => `${m.id}@${m.version}`).join(', ') : ''}; ${this.mods.length - on.length} disabled`);
    }

    /** Disable `m` once, keeping the first reason (a user's own choice is never overwritten by a later symptom). */
    private disable(m: LoadedMod, reason: DisableReason) {
        if (!m.enabled && m.disableReason) return;
        m.enabled = false;
        m.disableReason ??= reason;
    }

    /** Dependencies first, then `loadAfter`, otherwise by priority (lower first) and id. Missing deps / cycles disable the mod with a clear reason. */
    private order(mods: LoadedMod[]) {
        const byId = new Map<string, LoadedMod>();
        for (const m of mods) {
            const prev = byId.get(m.id);
            if (!prev) { byId.set(m.id, m); continue; }
            // The first copy with an id keeps it; every later copy is ignored, whether the first runs or not.
            if (!m.enabled) continue; // already disabled for its own reason
            this.log('error', `duplicate mod id "${m.id}" (${m.origin} ignored)`, { mod: m.id });
            this.disable(m, {
                kind: 'duplicate-id',
                message: `another mod with id "${m.id}" (${prev.origin}) comes first, so this copy is ignored`,
                mods: [m.id],
            });
        }        for (;;) {
            this.dropOrphans(mods, byId);
            const cycles = this.findDependencyCycles(mods, byId);
            if (!cycles.length) break;
            for (const cycle of cycles) {
                const names = [...cycle.map(m => m.id), cycle[0]!.id].join(' -> ');
                const ids = cycle.map(m => m.id);
                for (const m of cycle) {
                    this.log('error', `dependency cycle through "${m.id}"`, { mod: m.id });
                    this.disable(m, {
                        kind: 'dependency-cycle',
                        message: `part of a dependency cycle (${names}); none of them can be loaded first`,
                        mods: ids,
                    });
                }
            }
        }
        // Ordering: dependencies are acyclic here. `loadAfter` is a soft wish, so an edge that would close a
        // loop is dropped with a warning instead of taking mods down.
        const active = mods.filter(m => m.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        const done = new Set<string>(), visiting = new Set<string>(), out: LoadedMod[] = [];
        const visit = (m: LoadedMod) => {
            if (done.has(m.id) || !m.enabled) return;
            if (visiting.has(m.id)) return;
            visiting.add(m.id);
            for (const d of m.dependencies) { const dm = byId.get(d); if (dm?.enabled) visit(dm); }
            for (const d of m.loadAfter) {
                const dm = byId.get(d);
                if (!dm?.enabled) continue;
                if (visiting.has(dm.id)) { this.log('warn', `loadAfter "${d}" would form an ordering cycle; ignored`, { mod: m.id }); continue; }
                visit(dm);
            }
            visiting.delete(m.id); done.add(m.id);
            out.push(m);
        };
        active.forEach(visit);
        out.forEach((m, i) => (m.order = i));
    }

    /** Disable every enabled mod whose `dependencies` are missing or not enabled, repeating until nothing changes. */
    private dropOrphans(mods: LoadedMod[], byId: Map<string, LoadedMod>) {
        for (let changed = true; changed;) { // disabling a mod can orphan its dependents
            changed = false;
            for (const m of mods) {
                if (!m.enabled) continue;
                for (const d of m.dependencies) {
                    const dep = byId.get(d);
                    if (dep?.enabled) continue;
                    const what = !dep ? 'not installed' : 'disabled';
                    this.log('error', `requires mod "${d}", which is ${what}`, { mod: m.id });
                    this.disable(m, {
                        kind: 'missing-dependency',
                        message: dep
                            ? `needs "${d}", which is disabled${dep.disableReason ? ` (${dep.disableReason.message})` : ''}`
                            : `needs "${d}", which is not installed`,
                        mods: [d],
                    });
                    changed = true; break;
                }
            }
        }
    }

    /** Each dependency cycle among the enabled mods (self-dependency included), as its members in dependency order. */
    private findDependencyCycles(mods: LoadedMod[], byId: Map<string, LoadedMod>): LoadedMod[][] {
        const live = mods.filter(m => m.enabled);
        const index = new Map<string, number>(), low = new Map<string, number>(), stack: LoadedMod[] = [], onStack = new Set<string>();
        const cycles: LoadedMod[][] = [];
        let next = 0;
        const strong = (m: LoadedMod) => { // Tarjan: a strongly connected component with a dependency edge inside is a cycle
            index.set(m.id, next); low.set(m.id, next); next++;
            stack.push(m); onStack.add(m.id);
            const edges = m.dependencies.map(d => byId.get(d)).filter((x): x is LoadedMod => !!x?.enabled);
            for (const d of edges) {
                if (!index.has(d.id)) { strong(d); low.set(m.id, Math.min(low.get(m.id)!, low.get(d.id)!)); }
                else if (onStack.has(d.id)) low.set(m.id, Math.min(low.get(m.id)!, index.get(d.id)!));
            }
            if (low.get(m.id) !== index.get(m.id)) return;
            const scc: LoadedMod[] = [];
            for (;;) {
                const x = stack.pop()!;
                onStack.delete(x.id); scc.push(x);
                if (x === m) break;
            }
            const selfLoop = scc.length === 1 && scc[0]!.dependencies.includes(scc[0]!.id);
            if (scc.length > 1 || selfLoop) cycles.push(scc.reverse());
        };
        for (const m of live) if (!index.has(m.id)) strong(m);
        return cycles;
    }

    /**
     * OneLoader-style `requires` / `excludes` / `satisfies` / `skip_checks`. A missing requirement disables the mod. OneLoader
     * itself starts with no mods at all when two mods exclude each other; here that is a warning, so one clash can't take down a pack.
     */
    private checkCompatibility(mods: LoadedMod[]) {
        for (let changed = true; changed;) {
            changed = false;
            const live = mods.filter(m => m.enabled);
            const satisfied = new Set<string>();
            const skip = new Map<string, Set<string>>();
            for (const m of live) {
                satisfied.add(m.id.toLowerCase());
                for (const s of m.satisfies) satisfied.add(s.toLowerCase());
                for (const [victim, names] of Object.entries(m.skipChecks)) {
                    const set = skip.get(victim.toLowerCase()) ?? skip.set(victim.toLowerCase(), new Set()).get(victim.toLowerCase())!;
                    for (const n of names) set.add(n.toLowerCase());
                }
            }
            for (const m of live) {
                const skips = new Set(skip.get(m.id.toLowerCase()) ?? []);
                for (const s of m.satisfies) for (const n of skip.get(s.toLowerCase()) ?? []) skips.add(n);
                for (const req of m.requires) {
                    if (skips.has(req.toLowerCase()) || satisfied.has(req.toLowerCase())) continue;
                    this.log('error', `requires "${req}", which is not installed or not enabled`, { mod: m.id });
                    this.disable(m, {
                        kind: 'missing-dependency',
                        message: `requires "${req}", which is not installed or not enabled`,
                        mods: [req],
                    });
                    changed = true; break;
                }
            }
        }
    }

    /** Declared `excludes` clashes among the mods that ended up enabled. Warnings only; both sides keep running. */
    private collectConflicts(mods: LoadedMod[]) {
        this.lastConflicts = [];
        const live = mods.filter(m => m.enabled);
        const satisfiedBy = new Map<string, { id: string; name: string }[]>();
        for (const m of live) for (const k of [m.id, ...m.satisfies]) (satisfiedBy.get(k.toLowerCase()) ?? satisfiedBy.set(k.toLowerCase(), []).get(k.toLowerCase())!).push({ id: m.id, name: m.name });
        for (const m of live) {
            for (const ex of m.excludes) {
                const others = (satisfiedBy.get(ex.toLowerCase()) ?? []).filter(o => o.name !== m.name);
                if (!others.length) continue;
                const names = others.map(o => o.name);
                const message = `declares that it conflicts with "${ex}" (${names.join(', ')}), which is also enabled; they may fight over the same files`;
                this.log('warn', message, { mod: m.id });
                this.lastConflicts.push({ kind: 'declared-conflict', mod: m.id, target: ex, others: others.map(o => o.id), message });
            }
        }
    }

    private detectConflicts() {
        for (const [target, list] of this.edits) {
            const replacers = list.filter(e => e.edit.kind === 'replace' || e.edit.kind === 'raw');
            if (replacers.length > 1) {
                this.log('warn', `${target}: replaced by ${replacers.map(r => r.mod.id).join(' then ')}; the last one wins. Use a patch instead of a full replace to combine mods.`);
            }
        }
    }

    /** Build the player-facing snapshot from what ordering and compatibility settled on. */
    private buildSummary(mods: LoadedMod[], unreadable: DisabledModSummary[]): LoadSummary {
        const enabled: EnabledModSummary[] = mods
            .filter(m => m.enabled)
            .sort((a, b) => a.order - b.order)
            .map((m, i) => ({ order: i + 1, id: m.id, name: m.name, version: m.version, origin: m.origin }));
        const disabled: DisabledModSummary[] = mods
            .filter(m => !m.enabled)
            .map(m => ({
                id: m.id, name: m.name, version: m.version, origin: m.origin, userDisabled: m.userDisabled,
                reason: m.disableReason ?? (m.userDisabled
                    ? { kind: 'user-disabled', message: 'switched off in this profile' }
                    : { kind: 'invalid-manifest', message: m.errors.join('; ') || 'could not be loaded' }),
            }));
        disabled.push(...unreadable);
        const conflicts = [...this.lastConflicts];
        const total = enabled.length + disabled.length;
        return { version: this.version, enabled, disabled, conflicts, counts: { total, enabled: enabled.length, disabled: disabled.length, conflicts: conflicts.length } };
    }

    // ------------------------------------------------------------ queries
    activeMods() { return this.mods.filter(m => m.enabled).sort((a, b) => a.order - b.order); }

    scriptsFor(phase: ClientScript['phase']) {
        return this.activeMods().flatMap(m => m.scripts.filter(s => s.phase === phase).map(s => ({ mod: m.id, file: s.file })));
    }

    /** Names a mod adds to (or hides from) a game directory listing, so readdir sees new maps etc. */
    addedNames(dirRel: string): string[] {
        const prefix = dirRel ? dirRel.toLowerCase().replace(/\/+$/, '') + '/' : '';
        const names = new Set<string>();
        for (const [k, list] of this.edits) {
            if (!k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            if (!rest.includes('/')) names.add(list[0]!.edit.target.slice(list[0]!.edit.target.lastIndexOf('/') + 1));
        }
        return [...names];
    }

    modFile(id: string, path: string): Uint8Array | null {
        const m = this.mods.find(x => x.id === id && x.enabled);
        if (!m || !m.tree.files.includes(path)) return null;
        return m.tree.read(path);
    }

    // ------------------------------------------------------------ resolution
    hasEdits(gamePath: string) { const k = gamePath.toLowerCase(); return this.edits.has(k) || this.generated.has(k); }

    /** Register finished bytes for a game file (used for images patched by image deltas). They win over mod edits. */
    setGenerated(gamePath: string, bytes: Uint8Array) { this.generated.set(gamePath.toLowerCase(), bytes); }

    /**
     * Bytes for `gamePath` with all mod edits applied, or null when no mod touches it
     * (the caller then serves the original file). `baseBytes` is the original, if one exists.
     */
    resolve(gamePath: string, baseBytes: () => Uint8Array | null): Uint8Array | null {
        const gen = this.generated.get(gamePath.toLowerCase());
        if (gen) return gen;
        const list = this.edits.get(gamePath.toLowerCase());
        if (!list) return null;
        const sig = list.map(e => `${e.mod.id}:${e.mod.tree.stamp}:${e.edit.source}`).join('|');
        const hit = this.cache.get(gamePath.toLowerCase());
        if (hit?.sig === sig) return hit.bytes;

        const target = formatOfGamePath(gamePath);
        let base: Uint8Array | null | undefined; // undefined = not loaded yet
        const loadBase = () => (base === undefined ? (base = baseBytes()) : base);
        let plain: Uint8Array | null = null; // null = "still the original"
        let final = false;                    // `plain` is already in the game's on-disk form (a raw edit)
        let value: unknown; let haveValue = false;

        /** the file's current content as plain bytes */
        const currentBytes = (): Uint8Array => {
            if (plain) return plain;
            const b = loadBase();
            if (!b) throw new PatchError(`game file ${gamePath} does not exist, so it cannot be patched`);
            return target.crypt === 'aes' ? this.decrypt(b) : b;
        };
        const asValue = (): unknown => {
            if (haveValue) return value;
            if (final) throw new PatchError('cannot patch content that a mod supplied already encrypted');
            if (target.crypt === 'rpg') throw new PatchError('images and audio can only be replaced, not patched like data (image deltas are handled separately)');
            const bytes = currentBytes();
            value = target.fmt === 'yaml' ? yaml.safeLoad(dec.decode(bytes)) : JSON.parse(dec.decode(bytes).replace(BOM, ''));
            haveValue = true;
            return value;
        };
        const flush = () => { // serialise the working value back into `plain`
            if (haveValue) plain = enc.encode(target.fmt === 'yaml' ? yaml.safeDump(value, { lineWidth: -1 }) : JSON.stringify(value));
            haveValue = false;
        };
        const textOp = (fn: (current: string) => string) => {
            if (final) throw new PatchError('cannot patch content that a mod supplied already encrypted');
            flush();
            plain = enc.encode(fn(dec.decode(currentBytes())));
        };

        let applied = 0;
        for (const { mod, edit } of list) {
            try {
                const src = mod.tree.read(edit.source);
                switch (edit.kind) {
                    case 'replace': {
                        if (target.fmt === 'json') JSON.parse(dec.decode(src).replace(BOM, ''));
                        else if (target.fmt === 'yaml') yaml.safeLoad(dec.decode(src));
                        plain = src; haveValue = false; final = false; break;
                    }
                    case 'raw': plain = src; haveValue = false; final = true; break;
                    case 'jsonpatch': value = applyJsonPatch(asValue(), JSON.parse(dec.decode(src).replace(BOM, ''))); haveValue = true; break;
                    case 'merge': value = applyMergePatch(asValue(), JSON.parse(dec.decode(src).replace(BOM, ''))); haveValue = true; break;
                    case 'text': textOp(cur => applyTextPatch(cur, JSON.parse(dec.decode(src)))); break;
                    case 'append': textOp(cur => `${cur}\n${dec.decode(src)}\n`); break; // OneLoader's plugin delta: add the mod's text to the end
                }
                applied++;
            } catch (e) {
                const msg = e instanceof SyntaxError ? `invalid JSON/YAML in ${edit.source}: ${e.message}` : (e as Error).message;
                this.log('error', `${edit.kind} of ${gamePath} failed and was skipped: ${msg}`, { mod: mod.id, file: edit.source });
            }
        }
        flush();
        if (applied === 0 && plain === null) return null; // every edit failed: fall back to the original file
        let out = plain ?? new Uint8Array();
        if (!final) {
            if (target.crypt === 'aes') out = this.encrypt(out);
            else if (target.crypt === 'rpg') out = this.encryptAsset(out);
        }
        this.cache.set(gamePath.toLowerCase(), { sig, bytes: out });
        return out;
    }

    /** True when any active edit needs the original file (patches), as opposed to pure replacements. */
    needsBase(gamePath: string) { return !!this.edits.get(gamePath.toLowerCase())?.some(e => e.edit.kind !== 'replace' && e.edit.kind !== 'raw'); }

    /** Does any active mod touch a file the page can't serve itself (images, audio, plain scripts)? */
    hasAssetEdits() { for (const k of this.edits.keys()) if (!this.isEncrypted(k)) return true; return this.generated.size > 0; }

    /** True when `gamePath` is stored under the game's AES key, i.e. only code with that key (the page) can serve edits to it. */
    isEncrypted(gamePath: string) { return formatOfGamePath(gamePath).encrypted; }

    // ------------------------------------------------------------ crypto: game data (16-byte IV + AES-256-CTR)
    private cipher(iv: Uint8Array) {
        const k = this.getKey();
        if (!k) throw new Error('game key unavailable (check OMORI_DIR / Launch_OMORI.bat)');
        return new aesjs.ModeOfOperation.ctr(enc.encode(k), new aesjs.Counter(iv));
    }

    decrypt(buf: Uint8Array): Uint8Array {
        if (buf.length < 16) return new Uint8Array();
        return new Uint8Array(this.cipher(buf.slice(0, 16)).decrypt(buf.slice(16)));
    }

    encrypt(plain: Uint8Array): Uint8Array {
        const iv = crypto.getRandomValues(new Uint8Array(16)); // results are cached per file, so a fresh IV each time is fine
        const out = new Uint8Array(16 + plain.length);
        out.set(iv); out.set(this.cipher(iv).encrypt(plain), 16);
        return out;
    }

    // ------------------------------------------------------------ crypto: images and audio (RPG Maker header + XOR of the first 16 bytes)
    private rpgKey(): Uint8Array {
        if (!this.assetKey || !this.assetKey.length) throw new Error('asset key unavailable, so replaced images/audio cannot be encoded');
        return this.assetKey;
    }

    encryptAsset(plain: Uint8Array): Uint8Array {
        const key = this.rpgKey();
        const out = new Uint8Array(RPG_HEADER.length + plain.length);
        out.set(RPG_HEADER); out.set(plain, RPG_HEADER.length);
        for (let i = 0; i < 16 && i < plain.length; i++) out[RPG_HEADER.length + i] = plain[i]! ^ key[i % key.length]!;
        return out;
    }

    decryptAsset(enc16: Uint8Array): Uint8Array {
        const key = this.rpgKey();
        const out = enc16.slice(16);
        for (let i = 0; i < 16 && i < out.length; i++) out[i] = out[i]! ^ key[i % key.length]!;
        return out;
    }
}
