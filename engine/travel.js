// Leaving a world and coming back to it is one lifecycle, not a set of
// one-way jumps. A departure may start beside the portal (the player walks
// into the light), from a page, from flight or from first person; the loading
// screen, the page cards, the input state and the camera must agree before the
// journey and after it.
//
// The same lifecycle guards the edges:
//   - only one departure may run at a time; a second trigger is ignored
//     rather than starting a parallel loading screen;
//   - a cancelled, aborted or failed departure puts the player back beside
//     the portal (or at spawn when the world has none) with a usable camera
//     and no open page;
//   - an old departure that resumes after cancellation cannot navigate: every
//     await re-checks the journey ticket before touching history or the URL;
//   - a return through the door walks out of the light, a return through
//     history stands beside the portal, and a world without a portal lands
//     at spawn with the default view.
import { showLoading, hideLoading, finishLoading } from './ui/loading.js';
import { t } from './lang.js';
import { worldURL, worldKey, navigateDoor } from './door-protocol.js';
import { traveller } from './traveller.js';

// A departure whose navigation never happens (a blocked anchor, a stalled
// request, a browser that dropped the load without an event) leaves the
// loading screen up. After this long, with the page still visible, the
// journey is treated as failed and the world is handed back. A real
// navigation commits long before then.
const WATCHDOG = 12000;
// A walk into the light is a short scene; if it has not reached the light by
// then something interrupted the route, and the player goes back outside.
const WALK_WATCHDOG = 4000;

let live = null;
// The loading screen owns the viewport only while the journey is navigating.
// Walking into the light is a scene the player must see, so it is not a pause:
// the walk itself runs every frame while the input layer stays blocked.
export const isTravelling = () => live?.phase === 'sailing';
export const isLeaving = () => !!live?.active;

const departedKey = () => `homecraft-departed:${worldKey(location.href)}`;
const rememberDeparture = () => { try { sessionStorage.setItem(departedKey(), '1'); } catch {} };
const forgetDeparture = () => {
  try { sessionStorage.removeItem(departedKey()); } catch {}
  // The history entry kept for Back/Forward must stop claiming that a journey
  // is in progress, so an old departure cannot dress a later visit up as one.
  try {
    if (history.state?.homecraftPortal) { const state = { ...history.state }; delete state.homecraftPortal; history.replaceState(state, '', location.href); }
  } catch {}
};

// `closeOverlays` is supplied by main.js: it closes the page card, the phone,
// the weather menu, the big map and the photo studio, clears the input state
// and cancels any walk the player had queued.
export function createTravelLifecycle({ portal, player, rig, stage, reducedMotion, spawn, closeOverlays }) {
  let phase = 'idle'; // 'idle' | 'walking' | 'sailing'
  let epoch = 0;
  let timer = 0, walkTimer = 0;
  let left = false; // pagehide seen during this journey
  let lastReason = '';
  let lastArrival = '';

  const active = () => phase !== 'idle';
  const front = () => portal?.front || null;
  const lookAway = f => [f.x + Math.sin(f.heading) * 6, f.z + Math.cos(f.heading) * 6];

  // The world's own spawn point, facing the way the layout says, with the
  // camera at its default distance behind them.
  function placeSpawn() {
    const h = spawn.heading ?? Math.PI;
    const look = { look: [spawn.x + Math.sin(h), spawn.z + Math.cos(h)] };
    if (!player.teleport(spawn.x, spawn.z, look)) return false;
    rig.setFirstPerson(false);
    rig.reset();
    rig.recenter(player, true);
    return true;
  }

  // Beside the portal, facing away from it, camera behind the player: the
  // same view a visitor gets when they arrive through history. This is the
  // state a cancelled departure returns to, so it must be walkable at once.
  function placeBesidePortal() {
    const f = front();
    if (!f || !player.teleport(f.x, f.z, { look: lookAway(f) })) return placeSpawn();
    rig.setFirstPerson(false);
    rig.recenter(player, true);
    return true;
  }

  // The side view a history visit uses: the portal stays out of the camera's
  // way, and the player can walk off in any direction.
  function settleBesidePortal() {
    const f = front();
    if (!f || !player.teleport(f.x, f.z, { look: lookAway(f) })) return placeSpawn();
    portal.reset();
    rig.setFirstPerson(false);
    rig.set(f.heading + Math.PI * 0.52, 0.38, stage.camera.aspect < 0.8 ? 8.5 : 8);
    rig.recenter(player);
    return true;
  }

  function stopClock() {
    clearTimeout(timer); timer = 0;
    clearTimeout(walkTimer); walkTimer = 0;
  }

  // Give up the journey and hand the world back in an operable state.
  function cancel(reason = 'cancelled') {
    if (!active()) return false;
    epoch++;
    phase = 'idle';
    lastReason = reason;
    left = false;
    stopClock();
    forgetDeparture();
    portal?.reset();
    hideLoading();
    closeOverlays?.();
    player.cancel();
    placeBesidePortal();
    return true;
  }

  async function sail(world, ticket) {
    if (ticket !== epoch) return false;
    clearTimeout(walkTimer); walkTimer = 0;
    phase = 'sailing';
    const url = worldURL(world?.url);
    const name = (typeof world?.name === 'string' && world.name.trim()) || url?.hostname || '';
    showLoading(t(`正在前往 ${name}…`, `Loading ${name}…`), 0.08, world?.preview || null);
    let href = null;
    try { href = await traveller.link(world); } catch { href = null; }
    // Cancelled, superseded by another journey, or the link could not be made.
    if (ticket !== epoch) return false;
    if (!href) return cancel('unavailable');
    // Paint the real startup screen before navigating; the destination takes
    // over the bar at its actual boot stages.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (ticket !== epoch) return false;
    if (left) return false;
    history.replaceState({ ...history.state, homecraftPortal: true }, '', location.href);
    rememberDeparture();
    if (!navigateDoor(href)) return cancel('failed');
    stopClock();
    timer = setTimeout(() => {
      timer = 0;
      // The page is still here and visible with the same journey live: the
      // navigation never happened (Esc, a blocked link, a stalled request).
      if (ticket === epoch && phase === 'sailing' && document.visibilityState === 'visible') cancel('failed');
    }, WATCHDOG);
    return true;
  }

  // Start a departure. Walking in happens only on foot, in third person, with
  // motion allowed and the player already close to the front of the portal;
  // every other cause goes straight to the loading screen.
  function depart(world) {
    if (active()) return false;
    const url = worldURL(world?.url);
    if (!url || worldKey(url.href) === worldKey(location.href)) return false;
    epoch++;
    const ticket = epoch;
    left = false;
    lastReason = '';
    closeOverlays?.();
    player.cancel();
    if (portal?.canWalkIn(player) && !rig.firstPerson && !reducedMotion) {
      phase = 'walking';
      rig.set(portal.front.heading + 0.3, 0.2, 6.5);
      if (portal.leave(world, player, () => { if (ticket === epoch && phase === 'walking') void sail(world, ticket); })) {
        // The route can be interrupted (a teleport, a closed overlay); if the
        // light is not reached, hand the world back instead of waiting.
        walkTimer = setTimeout(() => {
          walkTimer = 0;
          if (ticket === epoch && phase === 'walking') cancel('stuck');
        }, WALK_WATCHDOG);
        return true;
      }
      phase = 'idle';
    }
    void sail(world, ticket);
    return true;
  }

  // Back into this world after loading. `how` is 'door' (through another
  // world's portal), 'history' (Back/Forward), or null for a fresh visit.
  function arrive(how) {
    stopClock();
    phase = 'idle';
    epoch++;
    left = false;
    closeOverlays?.();
    if (how === 'door' && portal && !reducedMotion) {
      const walkOut = portal.arrive(player);
      if (walkOut) {
        rig.setFirstPerson(false);
        rig.set(portal.front.heading + 0.45, 0.2, stage.camera.aspect < 0.8 ? 8 : 7);
        rig.recenter(player);
        stage.render();
        lastArrival = 'door-walk';
        finishLoading();
        walkOut();
        return lastArrival;
      }
    }
    if (how) {
      const placed = portal ? settleBesidePortal() : placeSpawn();
      lastArrival = !placed ? 'unchanged' : portal ? 'portal' : 'spawn';
      stage.render();
      finishLoading();
      return lastArrival;
    }
    // A fresh visit keeps the opening shot: the whole island, then in.
    if (!reducedMotion) rig.startIntro(player);
    lastArrival = 'intro';
    finishLoading();
    return lastArrival;
  }

  // Back/Forward into a page restored from the cache, when no journey is
  // running: reset the bar and put the player back beside the portal (or at
  // spawn) with the camera settled.
  function restore() {
    if (active()) return cancel('restored');
    showLoading(t('正在返回世界…', 'Loading the world…'), 1);
    closeOverlays?.();
    const placed = portal ? settleBesidePortal() : placeSpawn();
    if (!placed) placeSpawn();
    stage.render();
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!active()) finishLoading(); }));
  }

  // Escape, Back, an aborted navigation and a page coming back from the
  // cache all end the same way: the journey is invalidated and the world is
  // operable again. Capture phase keeps the input layer from acting on Esc.
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel('escape');
  }, true);
  addEventListener('popstate', () => { if (active()) cancel('back'); });
  addEventListener('pagehide', () => { if (active()) left = true; });
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    restore();
  });

  live = {
    get active() { return active(); },
    get phase() { return phase; },
    get epoch() { return epoch; },
    get lastReason() { return lastReason; },
    get lastArrival() { return lastArrival; },
    depart,
    cancel,
    arrive,
    restore,
  };
  return live;
}
