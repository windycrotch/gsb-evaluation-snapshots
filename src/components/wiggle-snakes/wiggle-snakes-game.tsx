'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from 'react';

import { trackEvent } from '@/lib/analytics';
import { playGobble, playMunch, playOops, playSuper, unlockWiggleAudio } from '@/lib/wiggle-audio';
import { activateSuper, settleEnding, superState } from '@/lib/wiggle-rules';
import { loadBest, loadSkin, recordBest, saveSkin } from '@/lib/wiggle-skins';
import {
  spawnPlayer,
  standings,
  type Standing,
  type World,
  type WorldEvent,
} from '@/lib/wiggle-world';

import { BoostButton, LengthBadge, Leaderboard, SuperButton } from './hud';
import { GameOverPanel, MenuPanel, type Ending } from './overlays';
import { useArena } from './use-arena';

type Phase = 'menu' | 'play' | 'over';
type Hud = { board: Standing[]; player?: Standing; total: number } & ReturnType<typeof superState>;
type Toast = { id: number; text: string };

const GAME = { game: 'wiggle-snakes' };
const noSubscribe = () => () => {};
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
const IDLE_INPUT = { angle: 0, boosting: false, steerId: null };

function readHud(world: World): Hud {
  const board = standings(world);
  return {
    board,
    player: board.find((s) => s.isPlayer),
    total: board.length,
    ...superState(world),
  };
}

export function WiggleSnakesGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('menu');
  // server and first client paint agree on the defaults; the saved values land right after
  const savedSkin = useSyncExternalStore(noSubscribe, loadSkin, () => 0);
  const savedBest = useSyncExternalStore(noSubscribe, loadBest, () => 0);
  const [pickedSkin, setSkin] = useState<number | null>(null);
  const [newBest, setBest] = useState<number | null>(null);
  const skin = pickedSkin ?? savedSkin;
  const best = newBest ?? savedBest;
  const [hud, setHud] = useState<Hud | null>(null);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const touch = useSyncExternalStore(noSubscribe, isTouch, () => false);
  /** The round on screen. Any event tagged with another round is stale and gets dropped. */
  const liveRound = useRef(-1);
  /** The loop and the key handler read this synchronously; effects must not lag a frame. */
  const phaseRef = useRef<Phase>('menu');

  const setPhaseNow = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const showEnding = useCallback(
    (world: World) => {
      // one shot per round: several contacts in one frame still settle the score exactly once
      const settled = settleEnding(world);
      if (!settled) return false;
      const record = settled.length > loadBest();
      const topLength = recordBest(settled.length);
      setBest(topLength);
      setEnding({ by: settled.by, length: settled.length, best: topLength, record });
      setHud(null);
      setToast(null);
      setPhaseNow('over');
      trackEvent('game_over', { ...GAME, length: String(settled.length) });
      return true;
    },
    [setPhaseNow]
  );

  const onEvent = useCallback(
    (event: WorldEvent, world: World) => {
      // a gobble queued by the previous round must never surface in the new one
      if (world.round !== liveRound.current) return;
      if (phaseRef.current !== 'play') return;
      if (event.type === 'munch') {
        if (event.snake.isPlayer) playMunch();
        return;
      }
      if (event.eater.isPlayer) {
        playGobble();
        setToast({ id: event.victim.id, text: `You gobbled ${event.victim.name}! 😋` });
      }
      // the sound belongs to the single settlement, not to every contact of the same death
      if (event.victim.isPlayer && showEnding(world)) playOops();
    },
    [showEnding]
  );

  const { worldRef, inputRef } = useArena(canvasRef, {
    onHud: (world) => {
      if (phaseRef.current === 'play') setHud(readHud(world));
    },
    onEvent,
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const start = () => {
    const world = worldRef.current;
    // the canvas loop has not mounted yet (or is being replaced): nothing to start on
    if (!world) return;
    unlockWiggleAudio();
    // spawnPlayer resets the round first, so a fast double-tap of Play cannot leave two
    // player snakes, an old gobble event, a stuck super charge or a queued respawn behind
    const player = spawnPlayer(world, skin);
    liveRound.current = world.round;
    // steer the new snake from its own heading, with no boost held over from the last round
    inputRef.current = { angle: player.angle, boosting: false, steerId: null };
    setHud(readHud(world));
    setEnding(null);
    setToast(null);
    setPhaseNow('play');
    trackEvent('game_start', GAME);
  };

  /** "pick another snake": the finished round must not keep ticking behind the menu. */
  const backToMenu = () => {
    const world = worldRef.current;
    if (world) {
      world.snakes = world.snakes.filter((s) => !s.isPlayer);
      world.player = null;
      world.events = [];
      world.ending = null;
    }
    liveRound.current = -1;
    inputRef.current = { ...IDLE_INPUT };
    setHud(null);
    setToast(null);
    setEnding(null);
    setPhaseNow('menu');
  };

  const pressSuper = useCallback(() => {
    const world = worldRef.current;
    // while charging, activateSuper refuses; repeated taps never stack extra seconds
    if (!world || phaseRef.current !== 'play' || !activateSuper(world)) return;
    playSuper();
    setHud(readHud(world));
    trackEvent('super_power', GAME);
  }, [worldRef]);

  useEffect(() => {
    if (phase !== 'play') return;
    const onKey = (e: KeyboardEvent) => {
      const down = e.type === 'keydown';
      if (e.code === 'Space') inputRef.current.boosting = down;
      else if (down && e.code === 'ArrowLeft') inputRef.current.angle -= 0.3;
      else if (down && e.code === 'ArrowRight') inputRef.current.angle += 0.3;
      else if (down && e.code === 'KeyS') pressSuper();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [phase, inputRef, pressSuper]);

  /** The head sits mid-screen, so steering is just "point from the middle to the finger". */
  const steer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    if (dx !== 0 || dy !== 0) inputRef.current.angle = Math.atan2(dy, dx);
  };

  return (
    <div
      className="relative w-full flex-1 touch-none self-stretch overflow-hidden bg-[#07091a] select-none"
      onPointerDown={(e) => {
        if (phase !== 'play') return;
        if (e.pointerType === 'mouse') inputRef.current.boosting = e.button === 0;
        else inputRef.current.steerId = e.pointerId;
        steer(e);
      }}
      onPointerMove={(e) => {
        if (phase !== 'play') return;
        if (e.pointerType === 'mouse' || e.pointerId === inputRef.current.steerId) steer(e);
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'mouse') inputRef.current.boosting = false;
        if (e.pointerId === inputRef.current.steerId) inputRef.current.steerId = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Snake arena" />

      {phase === 'play' && hud && (
        <>
          <SuperButton
            charge={hud.charge}
            active={hud.active}
            ready={hud.ready}
            left={hud.remaining}
            onPress={pressSuper}
          />
          <Leaderboard board={hud.board} player={hud.player} />
          <LengthBadge
            length={hud.player?.length ?? 0}
            rank={hud.player?.rank ?? 0}
            total={hud.total}
          />
          {touch && (
            <BoostButton
              onBoost={(on) => {
                inputRef.current.boosting = on;
              }}
            />
          )}
          {toast && (
            <div
              key={toast.id}
              className="pointer-events-none absolute top-[36%] left-1/2 -translate-x-1/2 animate-bounce rounded-full bg-black/55 px-4 py-1.5 text-base font-semibold whitespace-nowrap text-amber-200"
            >
              {toast.text}
            </div>
          )}
        </>
      )}

      {phase === 'menu' && (
        <MenuPanel
          skin={skin}
          best={best}
          onSkin={(i) => {
            setSkin(i);
            saveSkin(i);
          }}
          onPlay={start}
        />
      )}
      {phase === 'over' && ending && (
        <GameOverPanel ending={ending} onPlay={start} onMenu={backToMenu} />
      )}
    </div>
  );
}
