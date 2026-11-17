# Game Plan: Bytebound: Meadow Run

## Risk Tasks

### 1. Player movement and collision
- **Why isolated:** Platforming feel depends on tight interaction between acceleration, jump timing, camera movement, and tile collision.
- **Approach:** Use a deterministic fixed-step update, horizontal acceleration with a capped speed, jump buffering, a short coyote window, axis-separated rectangle collision, and authored tile-map geometry.
- **Verify:** Test idle→run, run→skid, jump→fall, fall→land, edge contact, enemy stomp, side damage, and checkpoint respawn dynamically.

### 2. Sprite-state transitions
- **Why isolated:** A small frame set can still stutter or show the wrong pose when movement direction and airborne state change together.
- **Approach:** Keep animation state derived from semantic player state and render the pose from a compact hand-authored frame table.
- **Verify:** Every transition shows a stable pose, with no snapping during a direction reversal or landing.

### 3. Touch input
- **Why isolated:** Mobile controls can conflict with scrolling, safe areas, and multi-touch if they are treated like keyboard shortcuts.
- **Approach:** Use pointer capture on large lower-corner controls and send the same semantic actions used by keyboard input.
- **Verify:** Hold left/right, tap jump while moving, release controls independently, and confirm the game never scrolls the page during play.

## Main Build

The web build is a full-screen Babylon.js canvas with a fixed logical playfield rendered through a dynamic texture. Plain TypeScript classes own gameplay state; React provides the canvas host and accessible touch/pause controls.

- **Assets needed:** Authored procedural hero, enemy, collectible, portal, tile, hill, tree, checkpoint, HUD, and button art; all rendered from the Signal Meadow palette.
- **Verify:** Movement, physics, animation, touch/keyboard parity, stage progression, persistence, visual consistency, and no browser console errors.

## Current constraint

The built-in image-generation quota is exhausted for this session. The art direction is still documented in `ideas.md`, while the first implementation uses deterministic original canvas art rather than external or copyrighted assets.
