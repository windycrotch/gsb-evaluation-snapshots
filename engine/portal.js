// A portal to other worlds. Walking into it, clicking it, or F beside
// it opens the list of worlds in the shared Homecraft directory. Choosing
// one spins the portal up; the player walks into it and steps out of the
// other world's portal, still the character they set out as. Only choosing
// a world navigates. The link format is a contract between sites that never
// update together: read docs/protocol.md before changing it.
//
// One journey has one deterministic lifecycle (engine/journey.js): from the
// moment any entry path claims the in-flight slot until navigation completes
// or the world is restored after a failure / BFCache return, every further
// attempt is ignored rather than queued, and stale callbacks from an older
// epoch can never touch the reset gate.
import * as THREE from 'three';
import * as L from '@world/layout.js';
import { config } from './config.js';
import { t, onLang } from './lang.js';
import { createGate } from './world/gate.js';
import { showLoading, finishLoading } from './ui/loading.js';
import { traveller } from './traveller.js';
import { worldURL, worldKey, navigateDoor, sourceLabel } from './door-protocol.js';
import { createDoorControls } from './door-controls.js';
import { DEFAULT_WORLDS } from './worlds-default.js';
import { createDirectory } from './door-directory.js';
import { createJourney } from './journey-run.js';

let cameFrom = null, cameFromName = '';

const easeInOut = p => (p < .5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const storageKey = name => `homecraft-${name}:${worldKey(location.href)}`;
const setDeparted = () => { try { sessionStorage.setItem(storageKey('departed'), '1'); } catch {} };
const clearDeparted = () => { try { sessionStorage.removeItem(storageKey('departed')); } catch {} };
const markHistory = () => { try { history.replaceState({ ...history.state, homecraftPortal: true }, '', location.href); } catch {} };
const clearHistory = () => {
  try {
    if (!history.state?.homecraftPortal) return;
    const state = { ...history.state }; delete state.homecraftPortal;
    history.replaceState(state, '', location.href);
  } catch {}
};

// main.js registers how to put the game back together (gate, player, input,
// camera) after a failed navigation or a BFCache restore. It is the only
// place that knows about the renderer.
let restoreGame = null;
export const onJourneyRestore = fn => { restoreGame = fn; };

// The single shared in-flight state for every entry path.
const journey = createJourney({
  t,
  returnLabel: () => t('正在返回世界…', 'Loading the world…'),
  showLoading,
  finishLoading,
  makeLink: next => traveller.link(next),
  navigate: navigateDoor,
  markDeparted: setDeparted,
  clearDeparted,
  markHistory,
  clearHistory,
  onRestore: reason => restoreGame?.(reason),
});
export const isTravelling = () => journey.isActive();
// Claim the shared in-flight slot. Returns the journey ticket, or null when
// a journey is already running: the caller must ignore the attempt.
export const beginTravel = () => journey.begin();

// Debug/test surface for the lifecycle; nothing in the app UI depends on it.
try { window.__homecraftJourney = { isTravelling, begin: beginTravel, disableFailureWatch: () => journey.disableFailureWatch() }; } catch {}

// PORTAL { x, z, yaw } in layout.js places the portal; yaw 0 faces south (+z).
export function createPortal({ stage, world, onOpen }) {
  const at = L.PORTAL;
  if (!at) return null;
  const yaw = Math.round((at.yaw || 0) / (Math.PI / 2)) * (Math.PI / 2);
  const ahead = d => ({ x: at.x + Math.sin(yaw) * d, z: at.z + Math.cos(yaw) * d });
  // Where a point is, in the portal's own terms: along its facing, and across.
  const local = p => {
    const dx = p.x - at.x, dz = p.z - at.z;
    return { along: dx * Math.sin(yaw) + dz * Math.cos(yaw), across: dx * Math.cos(yaw) - dz * Math.sin(yaw) };
  };
  const gate = createGate();
  const root = gate.group; root.name = 'portal';
  root.position.set(at.x, 0, at.z); root.rotation.y = yaw;
  stage.scene.add(root);

  // The light (and any frame) takes a thin strip: nobody walks through it without going.
  const sx = Math.abs(Math.cos(yaw)), sz = Math.abs(Math.sin(yaw)), half = gate.solid;
  const halfX = sx * half + sz * gate.depth, halfZ = sz * half + sx * gate.depth;
  world.obstacles.push({ x0: at.x - halfX, x1: at.x + halfX, z0: at.z - halfZ, z1: at.z + halfZ, level: 0 });
  root.updateMatrixWorld(true);
  const bounds = gate.box.clone().applyMatrix4(root.matrixWorld), hit = new THREE.Vector3();

  // charge: 0 idle, 1 open for a journey; show: the destination's picture
  // fading in; near: how close the player is. Plus a few timed steps.
  let charge = 0, chargeTo = 0, show = 0, showTo = 0, near = 0, busy = false, picture = null, armed = false;
  const timers = [];
  const later = (seconds, fn) => timers.push({ left: seconds, fn });
  const loader = new THREE.TextureLoader().setCrossOrigin('anonymous');
  // A preview (the destination's own picture) shows only if its site allows
  // it to be drawn here (CORS); otherwise the light stays.
  function load(src) {
    showTo = 0;
    if (!src) return;
    loader.load(src, texture => {
      if (!busy) { texture.dispose(); return; }
      const a = texture.image.width / texture.image.height, b = gate.aspect;
      texture.colorSpace = THREE.SRGBColorSpace;
      picture?.dispose(); picture = texture;
      gate.setPreview(texture, a > b ? [b / a, 1, (1 - b / a) / 2, 0] : [1, a / b, 0, (1 - a / b) / 2]);
      showTo = 1;
    }, undefined, () => {});
  }
  const lookOut = () => { const o = ahead(8); return [o.x, o.z]; };

  return {
    root,
    get busy() { return busy; },
    get front() { return { ...ahead(1.5), heading: yaw }; },
    pick(ray) { return ray.intersectBox(bounds, hit) ? hit.distanceTo(ray.origin) : null; },
    enter() { if (!journey.isActive() && !busy) onOpen?.(); },
    // Close enough, in front, and on foot: walk in. Otherwise just go.
    canWalkIn(player) {
      const { along, across } = local(player.pos);
      return player.mode === 'ground' && !player.island && along > 0.3 && along < 4.5 && Math.abs(across) < 3;
    },
    // Up to the light (from right in front of it, straight in), the portal
    // charges, then into it; then `gone`. The journey slot must already be
    // claimed by the caller via beginTravel(), so this never runs twice.
    leave(destination, player, gone) {
      if (busy) return;
      busy = true; load(destination.preview);
      const step = () => {
        chargeTo = 1;
        later(0.55, () => { if (!player.walkThrough([ahead(-0.2)], gone)) gone(); });
      };
      const { along, across } = local(player.pos);
      if (along < 1.7 && Math.abs(across) < gate.width / 2) step();
      else if (!player.walkThrough([ahead(1.5)], step, [at.x, at.z])) step();
    },
    // Arriving through a portal: stand in its light, fully open. The returned
    // function walks out once the world is showing, and the light settles.
    arrive(player) {
      const out = ahead(1.6), start = ahead(-0.3);
      if (!player.teleport(out.x, out.z, { look: lookOut() })) return null;
      player.pos.x = start.x; player.pos.z = start.z;
      charge = chargeTo = 1; busy = true; armed = false;
      const done = () => { chargeTo = 0; busy = false; };
      // A beat for the loading screen to fade, then out.
      return () => later(0.45, () => {
        if (!player.walkThrough([out], done, lookOut())) { player.teleport(out.x, out.z, { look: lookOut() }); done(); }
      });
    },
    // Back from the browser's page cache, or after a failed departure:
    // standing outside, the light at rest, every timed step cancelled.
    reset() {
      charge = chargeTo = 0; show = showTo = 0; busy = false; armed = false; timers.length = 0;
      gate.setPreview(null); picture?.dispose(); picture = null;
    },
    update(dt, player) {
      for (let i = timers.length - 1; i >= 0; i--) if ((timers[i].left -= dt) <= 0) timers.splice(i, 1)[0].fn();
      charge = chargeTo > charge ? Math.min(chargeTo, charge + dt / 0.6) : Math.max(chargeTo, charge - dt / 1.4);
      show = showTo > show ? Math.min(1, show + dt / 0.5) : Math.max(0, show - dt / 0.5);
      let close = 0;
      if (player) {
        const { along, across } = local(player.pos);
        close = 1 - THREE.MathUtils.smoothstep(Math.hypot(along, across), 2, 9);
        // Walking into the light opens the list, once, until you step back out.
        const inside = player.mode === 'ground' && !player.island && Math.abs(along) < gate.depth + 0.47 && Math.abs(across) < gate.width / 2;
        if (inside && armed && !busy && !journey.isActive()) { armed = false; onOpen?.(); }
        else if (!inside && (Math.abs(along) > 1.2 || Math.abs(across) > gate.width / 2 + 0.4)) armed = true;
      }
      near += (close - near) * Math.min(1, dt * 3);
      gate.update(dt, near, easeInOut(charge), show);
    },
  };
}

// ---------- The list ----------
const sources = (Array.isArray(config.portal.directory) ? config.portal.directory : []).filter(Boolean);
const directory = createDirectory(sources);
const worldUrl = worldURL, key = worldKey;
export const isCurrentWorld = url => key(url) === key(location.href);
// A name or line in one language, or { zh, en } for both. Plain text, trimmed.
const words = (value, max) => {
  const s = typeof value === 'string' ? value : value && typeof value === 'object' ? t(value.zh ?? value.en, value.en ?? value.zh) : '';
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
};
const listOf = data => (Array.isArray(data) ? data : Array.isArray(data?.worlds) ? data.worlds : []);
function entry(item) {
  if (!item || typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) return null;
  const url = worldUrl(item.url);
  if (!url) return null;
  const known = DEFAULT_WORLDS.find(w => key(w.url) === key(url.href));
  const given = item.logo ?? item.avatar; // early drafts called the logo `avatar`
  const logo = typeof given === 'string' ? worldUrl(given, url.href) : null;
  const preview = typeof item.preview === 'string' ? worldUrl(item.preview, url.href) : null;
  const lang = (Array.isArray(item.lang) ? item.lang : [item.lang]).filter(l => l === 'zh' || l === 'en');
  return {
    url: url.href, name: words(item.name, 60) || url.hostname, owner: words(item.owner, 40), intro: words(item.intro, 120),
    logo: known?.logo || logo?.href || null, preview: preview?.href || null, homecraft: item.homecraft === true, lang: [...new Set(lang)],
  };
}

// { worlds, join, all, missed }: missed means the directory was wanted but
// did not answer; join and all are the directory's own pages.
export function initialWorlds() {
  const shared = directory.peek();
  return { ...directoryWorlds(shared, false), ready: !!shared || !sources.length };
}
export async function getWorlds(force = false) {
  return directoryWorlds(await directory.read(force));
}
function directoryWorlds(shared, fallback = true) {
  const blocked = (Array.isArray(shared?.blocked) ? shared.blocked : []).map(key).filter(Boolean);
  const seen = new Set();
  const keep = list => listOf(list).slice(0, 256).map(entry).filter(w => {
    const id = w && key(w.url);
    if (!id || seen.has(id) || blocked.some(b => id === b || id.startsWith(b + '/'))) return false;
    seen.add(id); return true;
  });
  const worlds = keep(shared);
  if (fallback && sources.length && !worlds.length) worlds.push(...keep(DEFAULT_WORLDS));
  const page = value => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);
  return { worlds, join: page(shared?.join), all: page(shared?.all), missed: fallback && sources.length > 0 && !shared };
}

// ---------- Leaving ----------
// To a world that speaks the door protocol (homecraft: true), the link says
// where the visitor came from (?from=) and carries their character after #.
// Any other site gets a plain link. The journey slot is claimed by the
// caller through beginTravel(); this function only runs the claimed journey.
// It still claims a slot itself when called directly (the Return chip), so
// all three entry paths share the exact same in-flight state.
export async function visitWorld(next) {
  const url = worldUrl(next?.url);
  if (!url || isCurrentWorld(url.href)) return false;
  const ticket = journey.begin();
  if (ticket == null) return false;
  const name = next.name || url.hostname;
  const label = t(`正在前往 ${name}…`, `Loading ${name}…`);
  return journey.run(ticket, { label, preview: next.preview, next });
}

// Run a journey whose slot was already claimed by beginTravel() — the
// walk-in path needs the slot held across the gate animation. An invalid or
// current-world destination, or a stale ticket, ends the claimed journey as
// a failure so the gate and player are restored instead of staying busy.
export async function runClaimedTravel(ticket, next) {
  const url = worldUrl(next?.url);
  if (!journey.isCurrent(ticket)) return false;
  if (!url || isCurrentWorld(url.href)) { journey.fail(ticket); return false; }
  const name = next.name || url.hostname;
  const label = t(`正在前往 ${name}…`, `Loading ${name}…`);
  return journey.run(ticket, { label, preview: next.preview, next });
}

let controls = null;
export const placePortalControls = parent => controls?.mount(parent);
function mountReturn() {
  if (controls) return;
  const name = sourceLabel(cameFromName, cameFrom);
  controls = createDoorControls({
    parent: document.getElementById('hud'), openId: 'portalButton', backId: 'portalReturn',
    onOpen: () => window.__home?.openPortal(),
    onReturn: cameFrom ? () => { void visitWorld({ url: cameFrom, name, homecraft: true }); } : null,
  });
  const label = () => controls.label(t('传送门', 'Portal'), t(`返回 ${name}`, `Back to ${name}`), cameFrom || '');
  label(); onLang(label);
}

// Read the same arrival adapter used by ordinary sites. Its storage is scoped
// to this world, and a direct visit starts again as the host's character.
export function arrival() {
  const incoming = traveller.arrive();
  cameFrom = incoming.from; cameFromName = incoming.fromName;
  const historyVisit = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
  let returning = historyVisit && !!history.state?.homecraftPortal;
  try {
    returning ||= historyVisit && !!sessionStorage.getItem(storageKey('departed'));
    sessionStorage.removeItem(storageKey('departed'));
  } catch {}
  mountReturn();
  const how = incoming.door ? 'door' : returning ? 'history' : null;
  if (how) showLoading(t('正在进入世界…', 'Loading the world…'));
  return how;
}
