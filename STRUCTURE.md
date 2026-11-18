# AeroFlap Architecture

## Runtime Layout

```text
React shell
└── GameCanvas.tsx — Babylon lifecycle, DOM HUD, React display state
    └── game/scene.ts — scene bootstrap and teardown contract
        └── game/GameWorld.ts — game state, flight physics, obstacles, scoring, input
            └── game/assets.ts — stable generated-asset URLs
```

## Ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| `GameCanvas` | Canvas lifecycle, UI state, the visual overlay | Flight rules or obstacle behavior |
| `scene.ts` | Camera, scene, world creation, render-loop hookup contract | DOM UI |
| `GameWorld` | Player mesh, obstacle meshes, background layers, semantic input, score, persistence, cleanup | React state or component DOM |
| `assets.ts` | Generated storage URLs | Asset loading behavior |

## Game States

| State | Meaning | Accepted flight action |
| --- | --- | --- |
| `idle` | Launch screen; world is staged but still | Starts run and gives lift |
| `playing` | Physics and obstacle stream are active | Gives lift |
| `gameover` | Collision ended the run | Restarts run and gives lift |

## Asset Hints

The sky target fills a distant unlit plane. The cloud band uses transparent unlit planes and drifts at a slower rate than the obstacle gates. The plane art is a transparent texture layered above a simple procedural vermilion fallback. Gates are simple procedural boxes because their readability matters more than texture complexity.

