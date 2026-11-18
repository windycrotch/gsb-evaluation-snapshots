import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { CONFIG, GameWorld, type FlightState } from "./GameWorld";
import {
  CUSTOMIZATION_DEFAULTS,
  type CustomizationSnapshot,
} from "../../../shared/customization";

/**
 * Headless harness for GameWorld: Babylon's NullEngine provides a real scene,
 * meshes and materials without WebGL, while a minimal window/canvas stand-in
 * captures the DOM events and localStorage the world talks to.
 */

const DT = 1 / 60;

type GateState = {
  x: number;
  gapCenter: number;
  scored: boolean;
};

type WorldInternals = {
  gates: GateState[];
  materials: unknown[];
  score: number;
  best: number;
  playerY: number;
  velocity: number;
  speed: number;
  phase: string;
  viewportWidth: number;
};

type Handler = (event: unknown) => void;

function installBrowserShims() {
  const handlers = new Map<string, Set<Handler>>();
  const storage = new Map<string, string>();
  const states: FlightState[] = [];

  const windowShim = {
    location: { search: "" },
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    addEventListener: (type: string, handler: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    removeEventListener: (type: string, handler: Handler) => {
      handlers.get(type)?.delete(handler);
    },
    dispatchEvent: (event: { type?: string; detail?: FlightState }) => {
      if (event?.type === "aeroflap:state" && event.detail) {
        states.push(event.detail);
      }
      return true;
    },
  };

  (globalThis as Record<string, unknown>).window = windowShim;
  if (typeof globalThis.CustomEvent !== "function") {
    (globalThis as Record<string, unknown>).CustomEvent = class<T> {
      readonly type: string;
      readonly detail: T | undefined;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }

  return {
    states,
    storage,
    setSearch(search: string) {
      windowShim.location.search = search;
    },
    fire(type: string, event?: unknown) {
      handlers.get(type)?.forEach((handler) => handler(event ?? { type }));
    },
  };
}

type Shim = ReturnType<typeof installBrowserShims>;

function createCanvasShim() {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
}

function createWorld(shim: Shim) {
  const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
  const scene = new Scene(engine);
  const camera = new FreeCamera("test-camera", new Vector3(0, 0, -10), scene);
  const world = new GameWorld(scene, createCanvasShim(), camera);
  return { engine, scene, world };
}

function internals(world: GameWorld): WorldInternals {
  return world as unknown as WorldInternals;
}

/** Mirrors the built-in demo pilot: keeps the plane near the next gate's gap. */
function autoFlap(world: GameWorld, shim: Shim) {
  const state = internals(world);
  if (state.phase !== "playing") return;
  const nextGate = state.gates.find(
    (gate) => gate.x + CONFIG.obstacleWidth / 2 > CONFIG.playerX - 0.3,
  );
  const desiredY = nextGate ? nextGate.gapCenter : 0;
  if (
    state.playerY < desiredY - 0.32 ||
    (state.velocity < -4.2 && state.playerY < desiredY + 1.3)
  ) {
    shim.fire("aeroflap:flap");
  }
}

function applyPace(shim: Shim, pace: number) {
  const snapshot: CustomizationSnapshot = {
    settings: { ...CUSTOMIZATION_DEFAULTS, pace },
    assets: {},
  };
  shim.fire("aeroflap:customization", { detail: snapshot });
}

describe("GameWorld", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  function boot(options?: { demo?: boolean; best?: number }) {
    const shim = installBrowserShims();
    if (options?.demo) shim.setSearch("?demo");
    if (options?.best !== undefined) {
      shim.storage.set("aeroflap-best", String(options.best));
    }
    const { engine, scene, world } = createWorld(shim);
    cleanup = () => {
      world.dispose();
      scene.dispose();
      engine.dispose();
    };
    return { shim, world, state: internals(world) };
  }

  it("scores exactly once when the player passes through a gate", () => {
    const { world, state } = boot({ demo: true });
    const firstGate = state.gates[0];

    let guard = 0;
    while (!firstGate.scored && guard++ < 60 * 30) {
      world.update(DT);
    }

    expect(firstGate.scored).toBe(true);
    expect(state.score).toBe(1);
    expect(state.phase).toBe("playing");

    // The same gate must never contribute a second point. The next gate is
    // still more than a second away from the player, so any increase here
    // would be a double count of the first gate.
    for (let i = 0; i < 45; i++) {
      world.update(DT);
    }
    expect(state.score).toBe(1);
  });

  it("scores exactly once when a gate jumps past the player within a single frame", () => {
    const { shim, world, state } = boot();
    shim.fire("aeroflap:flap");
    expect(state.phase).toBe("playing");

    // Extreme pace: one frame moves gates further than gate + player width.
    applyPace(shim, 60);

    const gate = state.gates[0];
    gate.x = CONFIG.playerX + 3; // fully right of the player, no overlap
    state.playerY = 0;
    state.velocity = 0;

    world.update(DT); // the gate jumps from right of the player to fully past
    expect(gate.scored).toBe(true);
    expect(state.score).toBe(1);

    world.update(DT);
    world.update(DT);
    expect(state.score).toBe(1);
  });

  it("recycles gate meshes and materials once gates leave the viewport", () => {
    const { shim, world, state } = boot();
    shim.fire("aeroflap:flap");
    // Background + player materials stay forever; each live gate owns three.
    const sharedMaterials = state.materials.length - state.gates.length * 3;
    expect(sharedMaterials).toBe(2);

    let sawRemoval = false;
    let previousGateCount = state.gates.length;
    for (let i = 0; i < 60 * 15 && state.phase === "playing"; i++) {
      autoFlap(world, shim);
      world.update(DT);
      if (state.gates.length < previousGateCount) {
        sawRemoval = true;
      }
      previousGateCount = state.gates.length;
      // Every live gate owns exactly three materials; nothing else may leak.
      expect(state.materials.length).toBe(sharedMaterials + state.gates.length * 3);
    }

    expect(sawRemoval).toBe(true);
    expect(state.score).toBeGreaterThan(0);
  });

  it("clears gates, score and velocity on restart and rebuilds fresh gates", () => {
    const { shim, world, state } = boot();
    shim.fire("aeroflap:flap");

    // Play until at least one gate is scored.
    let guard = 0;
    while (state.score < 1 && state.phase === "playing" && guard++ < 60 * 30) {
      autoFlap(world, shim);
      world.update(DT);
    }
    expect(state.score).toBeGreaterThanOrEqual(1);

    // Stop flapping: the plane falls and the run ends.
    guard = 0;
    while (state.phase === "playing" && guard++ < 60 * 10) {
      world.update(DT);
    }
    expect(state.phase).toBe("gameover");
    expect(state.velocity).toBeLessThan(0);
    expect(shim.storage.get("aeroflap-best")).toBe(String(state.best));
    expect(state.best).toBe(state.score);

    const oldGates = [...state.gates];

    // Immediate restart from the game-over screen.
    shim.fire("aeroflap:flap");

    expect(state.phase).toBe("playing");
    expect(state.score).toBe(0);
    expect(state.playerY).toBe(0);
    expect(state.speed).toBe(CONFIG.startingSpeed);
    // The restart flap is the only impulse; no leftover fall speed remains.
    expect(state.velocity).toBe(CONFIG.flapVelocity);

    // All previous gates are gone; the new run starts with unscored gates.
    expect(state.gates.length).toBeGreaterThan(0);
    expect(state.gates.every((gate) => !gate.scored)).toBe(true);
    expect(state.gates.every((gate) => !oldGates.includes(gate))).toBe(true);
    expect(state.gates.every((gate) => gate.x > CONFIG.playerX)).toBe(true);
    // The first gate reappears to the right of the visible viewport.
    expect(state.gates[0].x).toBeGreaterThan(state.viewportWidth / 2);

    // The HUD contract is intact: score/best/phase on every state event.
    const lastState = shim.states.at(-1);
    expect(lastState).toEqual({ score: 0, best: state.best, phase: "playing" });
    expect(shim.states.length).toBeGreaterThan(0);
  });

  it("reads the persisted best score from the aeroflap-best localStorage key", () => {
    const { state } = boot({ best: 7 });
    expect(state.best).toBe(7);
  });
});
