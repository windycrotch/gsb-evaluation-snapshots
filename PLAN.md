# Game Plan: AeroFlap

## Risk Tasks

### 1. Endless obstacle pacing and collision flow
- **Why isolated:** The obstacle stream must feel fair across changing viewport widths while reliably recognizing both pipe collisions and score passes.
- **Approach:** Maintain a small data-owned obstacle-pair collection, spawn from the camera’s right boundary, shrink the gap gently as score rises, and use axis-aligned collision tests against the player’s stable flight bounds.
- **Verify:** The first obstacle reaches the player after a playable lead-in; score increments once per cleared gate; top, bottom, and gate collisions consistently end the run without accidental double scoring.

### 2. Flight control and demo autopilot
- **Why isolated:** The core game depends on a responsive input-to-velocity transition and a deterministic scene demonstration for visual validation.
- **Approach:** One semantic `flap` action accepts pointer, touch, Space, Arrow Up, and overlay button signals; a `?demo` mode estimates the next gate center and triggers the same action.
- **Verify:** Each supported input visibly lifts and pitches the plane; an idle game starts on its first action; the demo mode produces a moving, scoring play state without manual interaction.

## Main Build

Build a full-screen orthographic Babylon scene inside a React safety shell. The scene contains a generated editorial sky background, drifting cloud layers, a generated paper-plane sprite with a procedural fallback, colored obstacle gates, a score system, game-over restart flow, local best-score persistence, and a DOM-based accessible HUD.

- **Assets:**
  - `sky target` background, displayed full viewport.
  - `paper plane` sprite, displayed at approximately 112x84 px.
  - `cloud band` parallax layer, displayed at approximately 1.25 viewport widths.
  - `wing mark` brand icon, displayed at 44x44 px.
- **Verify:**
  - Pointer, touch, Space, and Arrow Up all map to the same flap action.
  - Gravity, ceiling/ground contacts, obstacle contacts, and restart flow are visibly correct.
  - Score and best score remain readable without obstructing the flight path.
  - Generated artwork is visible in the delivered game with no broken-image fallback.
  - `?demo` shows a live, scoring run for visual review.
  - No TypeScript or browser-console errors occur during capture.
  - The visual treatment matches the Sunlit Paper Skies target: high-key sky, dark-ink instruments, vermilion action, and layered cloud depth.

