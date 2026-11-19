import { Player, type PlayerAPI, PlayerEvent, type SourceConfig } from 'bitmovin-player';
import { UIFactory } from 'bitmovin-player-ui';
import 'bitmovin-player-ui/dist/css/bitmovinplayer-ui.css';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { type Film, type Preview } from '../../../discover/model.js';
import { ICON } from '../cover.js';
import { Icon } from '../Icon.js';
import { type PreviewAction, PreviewWindowController } from './previewWindow.js';
import { PlayerLoading, PreviewErrorCard } from './shared.js';

const LOAD_TIMEOUT_MS = 30_000; // how long a source may take to load before the stage reports a failure

export interface PreviewPlayerProps {
  film: Film & { preview: Preview };
  licenseKey: string;
  /** Fires each time the preview window plays through (again after a replay). */
  onEnded?: () => void;
  /** Fires once if the preview cannot load or play here. */
  onError?: () => void;
  /** Fires when the user replays the preview from the end card. */
  onReplay?: () => void;
  /** The hand-off to the full film, shown on the end card and on the error card. */
  handoff?: ReactNode;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Plays a preview window of a film: from `preview.startSec` for
 * `preview.durationSec`, then pauses and shows an end card. The window comes
 * from the server's screen data and is enforced client-side on the full film's
 * stream, so a "trailer" needs no separate encode. The player's seek bar still
 * spans the whole film: seeking past the window ends the preview, and seeking
 * back before it returns to the window's start. The window rules live in
 * PreviewWindowController; this component only wires them to the player.
 *
 * Mounts the Bitmovin Player into a ref'd node that React leaves alone, since
 * the player appends its own DOM. Overlays are siblings React controls. A film
 * switch on this same component destroys the old player and resets every
 * per-film marker — countdown, end card, error — so nothing carries over.
 */
export function PreviewPlayer({ film, licenseKey, onEnded, onError, onReplay, handoff }: PreviewPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerAPI | null>(null);
  const controllerRef = useRef<PreviewWindowController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [remaining, setRemaining] = useState(film.preview.durationSec);

  const { stream, startSec, durationSec } = film.preview;

  // A different film (or window, or key) on this same component starts clean:
  // the previous preview's countdown, end card and error must not leak into
  // the next one. Reset during render, so not even one frame of the old card
  // shows against the new film; the effect below then builds a fresh player.
  const sessionKey = `${film.title}|${stream.type}|${stream.url}|${startSec}|${durationSec}|${licenseKey}`;
  const [session, setSession] = useState(sessionKey);
  if (session !== sessionKey) {
    setSession(sessionKey);
    setLoading(true);
    setError(null);
    setEnded(false);
    setRemaining(durationSec);
  }

  // Called from player events, which are wired once per film: these always see
  // the parent's latest callbacks without rebuilding the player.
  const fireEnded = useEffectEvent(() => onEnded?.());
  const fireError = useEffectEvent(() => onError?.());

  useEffect(() => {
    const node = mountRef.current;
    if (!node) {
      return;
    }

    // The window state machine for this film only; the next film gets a fresh
    // one, so its ended latch and countdown can never be inherited.
    const controller = new PreviewWindowController({ startSec, durationSec });
    controllerRef.current = controller;

    let active = true; // false once this film's player is torn down
    let loadTimer: ReturnType<typeof setTimeout> | undefined;

    // One container per player, so teardown can detach this player's DOM alone.
    const container = document.createElement('div');
    node.appendChild(container);

    const player: PlayerAPI = new Player(container, {
      key: licenseKey,
      // Playback starts manually after load() so the play() promise is ours to
      // catch; config autoplay leaves an uncaught rejection when blocked.
      playback: { autoplay: false, muted: true },
      // A preview plays in a small widget: never fetch renditions larger than
      // the player, which would otherwise climb to 4K on a fast connection.
      adaptation: { limitToPlayerSize: true },
      ui: false,
    });
    playerRef.current = player;
    const uiManager = UIFactory.buildUI(player);

    // Releases everything this film's preview holds: the load timer, the UI,
    // the player's DOM and the player itself (which also stops a load still in
    // flight). Runs exactly once — on unmount, on a film switch, and on failure.
    const teardown = () => {
      if (!active) {
        return;
      }
      active = false;
      clearTimeout(loadTimer);
      playerRef.current = null;
      uiManager.release();
      container.remove();
      void player.destroy().catch(() => {});
    };

    // A load timeout or a player error: stop the countdown and the load, free
    // the player and UI behind the card, and show the error card (which keeps
    // the hand-off to the full film) instead of a player that never starts.
    const fail = (detail: string) => {
      if (!active) {
        return;
      }
      setError(detail);
      fireError();
      teardown();
    };

    const apply = (action: PreviewAction) => {
      switch (action.type) {
        case 'seek-back':
          player.seek(action.to);
          break;
        case 'tick':
          setRemaining(action.remaining);
          break;
        case 'finish':
          player.pause();
          setEnded(true);
          setRemaining(0);
          fireEnded();
          break;
        case 'ignore':
          break;
      }
    };

    player.on(PlayerEvent.Ready, () => {
      if (active) {
        setLoading(false);
      }
    });
    player.on(PlayerEvent.TimeChanged, e => {
      if (active) {
        apply(controller.onTimeChanged(e.time));
      }
    });
    player.on(PlayerEvent.PlaybackFinished, () => {
      if (active) {
        apply(controller.onPlaybackFinished());
      }
    });
    player.on(PlayerEvent.Error, e => fail(`Error ${e.code}: ${e.message ?? 'playback failed'}`));

    const source: SourceConfig = { title: film.title, options: { startOffset: startSec } };
    if (stream.type === 'hls') {
      source.hls = stream.url;
    } else {
      source.dash = stream.url;
    }

    const timeout = new Promise<never>((_, rej) => {
      loadTimer = setTimeout(
        () => rej(new Error(`The preview did not load within ${LOAD_TIMEOUT_MS / 1000}s.`)),
        LOAD_TIMEOUT_MS,
      );
    });
    Promise.race([player.load(source), timeout])
      .then(() => {
        if (!active) {
          return;
        }
        // In a sandbox that blocks even muted autoplay the rejection is benign;
        // the user can press play.
        player.play().catch(() => {});
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
      .finally(() => clearTimeout(loadTimer));

    return teardown;
  }, [film.title, stream.url, stream.type, startSec, durationSec, licenseKey]);

  const replay = () => {
    const player = playerRef.current;
    const controller = controllerRef.current;
    if (!player || !controller) {
      return;
    }
    const seekTo = controller.replay(); // re-arm the cut-off and the countdown
    setEnded(false);
    setRemaining(controller.remaining);
    onReplay?.();
    player.seek(seekTo);
    player.play().catch(() => {});
  };

  return (
    <div className="player-stage preview-stage">
      <div className="player-mount" ref={mountRef} />
      {!loading && !error && !ended ? (
        <div className="preview-chip" aria-live="off">
          Preview · {clock(remaining)} left
        </div>
      ) : null}
      {loading && !error ? <PlayerLoading title={film.title} /> : null}
      {error ? (
        <PreviewErrorCard title={film.title} handoff={handoff} detail={error} />
      ) : ended ? (
        <div className="preview-end">
          <div className="preview-end-kicker">That was the preview</div>
          <div className="preview-end-title">{film.title}</div>
          <div className="preview-end-actions">
            {handoff}
            <button className="btn btn-ghost" onClick={replay}>
              <Icon html={ICON.replay} />
              Replay preview
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
