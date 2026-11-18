// Room radio: the SYSTEM controls the track and position; pausing is local only.
// The room's Durable Object is the shared clock: on join and on every change it
// sends { idx, sec, at } — the track, the second inside it and the SERVER time of
// that snapshot. The client measures its clock offset from `at` and follows the
// server clock, so devices with a wrong local time still hear the same second.

import { PLAYLIST } from "./playlist.js";
export { PLAYLIST };

const START = Date.UTC(2026, 0, 1); // offline fallback zero (before any server state)
const FALLBACK = 3600; // a video with unknown duration counts as 1h
const durations = {}; // id -> seconds (learned as each video loads)

let player = null;
let playingIdx = -1;
let loadedId = null; // last video id we asked the player to load
let paused = false;
// mute is per person and remembered; the radio keeps playing (and in sync) underneath
let muted = false;
try { muted = localStorage.getItem("muted") === "1"; } catch {}

// Last state from the server: { idx, sec, at } with `at` on the SERVER clock (ms).
// clockOffset converts local time to server time, so all position math shares
// one clock even when a device's time is off.
let base = null;
let clockOffset = 0;
let baseVersion = 0; // bumped on every new base (server state or local rebase)
// point frozen by a local pause: { idx, sec, version } — resume continues from here
let frozen = null;

const serverNow = () => Date.now() + clockOffset;

function loadApi() {
  return new Promise((ok) => {
    if (window.YT?.Player) return ok();
    window.onYouTubeIframeAPIReady = ok;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
}

// walk the playlist forward from (idx, sec) by t seconds
function advance(idx, sec, t) {
  for (let n = 0; n < 1000; n++) {
    const d = durations[PLAYLIST[idx]] || FALLBACK;
    if (sec + t < d) return { idx, sec: sec + t };
    t -= d - sec;
    sec = 0;
    idx = (idx + 1) % PLAYLIST.length;
  }
  return { idx: 0, sec: 0 };
}

// Which video and which second, right now (on the server clock). A video with
// unknown duration counts as 1h until it loads (then it's recomputed).
function nowOnRadio() {
  if (base) return advance(base.idx, base.sec, Math.max(0, (serverNow() - base.at) / 1000));
  // no server state yet (offline): local clock from the fixed zero
  const total = PLAYLIST.reduce((s, id) => s + (durations[id] || FALLBACK), 0);
  let t = ((Date.now() - START) / 1000) % total;
  for (let i = 0; i < PLAYLIST.length; i++) {
    const d = durations[PLAYLIST[i]] || FALLBACK;
    if (t < d) return { idx: i, sec: t };
    t -= d;
  }
  return { idx: 0, sec: 0 };
}

// With a server: admin commands and learned durations go to the room's Durable
// Object, which broadcasts the resulting state to everyone (including back here).
let server = null; // { command(idx), duration(id, sec) }
export function connectRadioToServer(hooks) {
  server = hooks;
}

// The room sent the current radio state: { idx, sec, at } (at = server time).
export function receiveRadioState(s) {
  if (!s || !Number.isFinite(s.idx) || !Number.isFinite(s.sec) || !Number.isFinite(s.at)) return;
  clockOffset = s.at - Date.now();
  base = {
    idx: (((s.idx | 0) % PLAYLIST.length) + PLAYLIST.length) % PLAYLIST.length,
    sec: Math.max(0, Number(s.sec) || 0),
    at: s.at,
  };
  baseVersion++;
  sync();
}

function applyCommand(idx) {
  idx = (idx + PLAYLIST.length) % PLAYLIST.length;
  if (server) return server.command(idx); // wait for the server to confirm
  // offline: apply locally, from 0:00
  base = { idx, sec: 0, at: serverNow() };
  baseVersion++;
  sync();
}

// Admin controls (local when offline; go to the room server in multiplayer)
export const admin = {
  restart: () => applyCommand(Math.max(0, playingIdx)),
  next: () => applyCommand(playingIdx + 1),
  previous: () => applyCommand(playingIdx - 1),
};

// HUD elements, set by startRadio
let elTitle = null;
let elTime = null;
let elBar = null;

function sync() {
  if (paused || !player?.getPlayerState) return;
  const { idx, sec } = nowOnRadio();
  if (idx !== playingIdx) {
    playingIdx = idx;
    // restart with a 1-video playlist: same id, just seek back. Compare with the
    // last video we REQUESTED, not the player's current data: after quick cuts
    // (A→B→A) the player may still hold A's data while B's load is in flight.
    if (PLAYLIST[idx] === loadedId) player.seekTo(sec, true);
    else {
      loadedId = PLAYLIST[idx];
      if (elTitle) elTitle.textContent = "—"; // until the new video's data arrives
      player.loadVideoById({ videoId: loadedId, startSeconds: sec });
    }
    return;
  }
  // correct drift (ads, slow connection) of more than 3s
  const current = player.getCurrentTime?.() || 0;
  if (Math.abs(current - sec) > 3 && player.getPlayerState() === YT.PlayerState.PLAYING) player.seekTo(sec, true);
  if (player.getPlayerState() !== YT.PlayerState.PLAYING && player.getPlayerState() !== YT.PlayerState.BUFFERING) player.playVideo();
}

// displayed position: frozen while paused locally, live otherwise
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function updateDisplay() {
  if (!elTime && !elBar) return;
  const pos = frozen || nowOnRadio();
  const d = durations[PLAYLIST[pos.idx]];
  if (elTime) elTime.textContent = `${fmt(pos.sec)} / ${d ? fmt(d) : "--:--"}`;
  if (elBar) elBar.style.width = d ? `${Math.min(100, (pos.sec / d) * 100)}%` : "0%";
}

const TOUCH = matchMedia("(pointer: coarse)").matches;

export async function startRadio({ elPlayer, elTitle: title, elTime: time, elBar: bar }) {
  elTitle = title;
  elTime = time || null;
  elBar = bar || null;
  await loadApi();
  const { idx, sec } = nowOnRadio();
  playingIdx = idx;
  loadedId = PLAYLIST[idx];
  // cover with the video's thumbnail whenever it isn't playing, so YouTube's big
  // pause/play overlay and logo never show in the little TV
  const cover = Object.assign(document.createElement("img"), { className: "tv-cover", alt: "" });
  document.getElementById(elPlayer).parentElement.append(cover);
  // YouTube shows its pause button and channel badge for a few seconds after playback
  // starts, so the cover only lifts once that has faded
  let coverTimer = 0;
  const setCover = (playing) => {
    clearTimeout(coverTimer);
    if (playing) coverTimer = setTimeout(() => (cover.hidden = true), 4500);
    else {
      cover.src = `https://i.ytimg.com/vi/${PLAYLIST[Math.max(0, playingIdx)]}/hqdefault.jpg`;
      cover.hidden = false;
    }
  };
  setCover(false);
  player = new YT.Player(elPlayer, {
    width: 176,
    height: 99,
    videoId: PLAYLIST[idx],
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, start: Math.floor(sec) },
    events: {
      onReady: (e) => {
        e.target.setVolume(70);
        // phones only autoplay muted (the tap on "enter" is used up while the API loads):
        // start muted and turn the sound on at the next touch
        if (TOUCH) {
          e.target.mute();
          const unmute = () => {
            if (muted) return;
            e.target.unMute();
            e.target.setVolume(70);
            if (!paused) e.target.playVideo();
          };
          addEventListener("pointerdown", unmute, { once: true, capture: true });
        }
        if (muted) e.target.mute();
        if (paused) e.target.pauseVideo();
        else e.target.playVideo();
      },
      onStateChange: (e) => {
        const p = e.target;
        setCover(e.data === YT.PlayerState.PLAYING);
        if (paused && e.data === YT.PlayerState.PLAYING) {
          p.pauseVideo();
          return;
        }
        if (e.data === YT.PlayerState.PLAYING) {
          const data = p.getVideoData?.() || {};
          // a LATE event from the previous video (its load was replaced by a cut):
          // it must not overwrite the current track's duration or title
          if (data.video_id && data.video_id !== PLAYLIST[playingIdx]) return;
          const id = data.video_id || PLAYLIST[playingIdx];
          const d = p.getDuration();
          if (d && durations[id] !== d) {
            durations[id] = d;
            server?.duration?.(id, d); // tell the room, so join state is exact
            sync(); // now with the real duration, recompute the point
          }
          if (elTitle) elTitle.textContent = data.title || "—";
        }
        if (e.data === YT.PlayerState.ENDED) sync();
      },
      onError: () => {
        // video unavailable / not embeddable: skip to the next
        durations[PLAYLIST[playingIdx]] = 1;
        sync();
      },
    },
  });
  setInterval(sync, 5000);
  setInterval(updateDisplay, 250);
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("muted", m ? "1" : "0"); } catch {}
  if (!player?.mute) return;
  if (m) player.mute();
  else {
    player.unMute();
    player.setVolume(70);
  }
}

export function pauseRadio() {
  if (paused) return;
  paused = true;
  // freeze the displayed position; resume continues from here
  frozen = { ...nowOnRadio(), version: baseVersion };
  player?.pauseVideo?.();
  updateDisplay();
}

export function resumeRadio() {
  if (!paused) return;
  paused = false;
  // continue from the frozen point instead of jumping to the live position:
  // rebase the radio right here (unless a new server state arrived meanwhile)
  if (frozen && frozen.version === baseVersion) {
    base = { idx: frozen.idx, sec: frozen.sec, at: serverNow() };
    baseVersion++;
  }
  frozen = null;
  sync();
  updateDisplay();
}
