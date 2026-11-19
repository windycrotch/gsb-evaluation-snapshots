# castle-valley

Playable three.js recreation of a pixel-art clip (forest path, village, castle), with goblins and trolls to fight.
Vite + TypeScript, no framework.

Run `pnpm typecheck` after every change. `pnpm dev` starts Vite.

The game is a static site on Cloudflare Workers (`wrangler.jsonc`, no Worker code). `pnpm run deploy` puts it on
the workers.dev preview, `pnpm run deploy:prod` on https://omw-game.kimaki.dev. Deploy the preview first and open it.

## architecture

```
src/main.ts ───────▶ renderer, input, player step (walk, jump, health), game loop, debug hook
   │
   ├──▶ src/world.ts ───── buildWorld(): one static scene, built once at load (about 2.5 million dabs)
   │       groundHeight(x, z) ◀── axis slope table + valley funnel + far hills   (also moves the player)
   │       buildZones() ─────────▶ zone map read while painting: r path, g lit ground, b forest shade
   │       buildGround() ────────▶ under mesh + strokes, finer near the paths (GROUND_BANDS), grass tufts
   │       layout tables (trees, bushes, houses, castle, peaks) ──▶ painters in things.ts
   │       sky, mist banks, cloud veil: dabs placed directly
   │
   ├──▶ src/things.ts ──── painters for kinds of things, each lays underpainting + strokes on a Canvas:
   │                       paintSolid (walls, roofs, rock), paintCrown (leaves), paintTrunk, paintFir, paintTuft
   │
   ├──▶ src/paint.ts ───── RAMPS palette, Dabs (instanced cards + the one dab shader), Under, noise helpers
   │       └──▶ src/brush.ts ── the brush sheet: eight marks made in code
   │
   ├──▶ src/mobs.ts ────── buildMobs(): goblins and trolls in camps (CAMPS). update() ──▶ think (stance: roam,
   │                       chase, windup, recover, reel, dead) ──▶ move ──▶ pose. strike(): the sword lands
   │
   ├──▶ src/audio.ts ───── buildAudio(): samples from public/audio through the Web Audio API, wind and torch
   │                       loops, the song. play({ sound, at }) is quieter with distance and panned
   │
   └──▶ src/viewmodel.ts ─ hands as pixel sprites (torch, sword), flame wobble, sparks, hearts: own scene with
                           an orthographic camera in reference pixels, drawn after the world
```

One frame (`advance` in `main.ts`):

```
step(dt) ──▶ mobs.update() ──▶ hearts their blows take ──▶ hurt()      (not within GRACE_SECONDS of the last blow)
         ──▶ hands.update() ─▶ struck: the blade lands ──▶ mobs.strike() ──▶ flash, knock back, flecks, death
         ──▶ MobEvent[] from both ──▶ audio.play()        (MOB_SOUNDS maps what a creature did to a sound)
         ──▶ render()
```

The painter follows https://patch.gg/blendi/oil-paint (source: `~/Documents/GitHub/oil-paint`). Read its
`src/oilpaint/dabs.js`, `src/night/kit.js`, `src/world/forest.js` and `src/night/pines.js` before changing a painter.

- **Everything visible is a dab or an under mesh.** No lights. The look must stay pinned to the world: never add
  an effect that makes the look on screen (pixel grids, blurs, outlines). The finish only grades, antialiases and firms edges.
- **The finish** (`main.ts`) is the one pass over the picture. The world is drawn into a render target (4 samples)
  and finished pixel by pixel: antialiasing (FXAA that reaches 2 pixels, a longer reach smears small strokes), a
  sharpening that never passes the lightest or darkest neighbour (`sharpened`), the grade (shade toward violet,
  light toward warm, a lift in the darks), then the
  weave of the canvas, a rolloff of the brightest paint, and varnish. The palette is saturated on purpose and
  the grade holds it together. The hands are drawn after it, unfinished.
- **The picture is drawn at the screen's own pixels** (up to 2400 on the short side): stretched, far things turn
  soft. `keepPace` gives up pixels a step at a time when most frames are slow. Stroke sizes do not depend on it.
- **Dabs** are instanced cards that show one mark of the brush sheet. `face` dabs turn to the eye and run along
  `dir` on the canvas. `lie` dabs lie on a surface and are stood up when seen edge on. Edges are cut with
  alpha to coverage, so the render target needs its samples. A mark's edge is one pixel wide on screen
  (`fwidth`), and the raking light fades out at the rim: wide soft edges and rim highlights shimmer in motion.
- **Colours are baked** when the world is built. The shader breaks each colour a little (`jitter`), streaks a
  lighter one into it, and rakes a light across the paint (`uImpasto`).
- **Sun and shade** (`bakeShade` in `paint.ts`): the depth of the valley's under meshes is drawn once from the
  sun. Each dab asks it for its own spot and takes sun or shade whole, so a shadow's edge is a ragged line of
  whole dabs. Meshes that should cast shade need `layers.enable(CASTER_LAYER)`.
- **Mist** is by true distance from the eye, per dab (`hazed`). Never bake haze into colours.
- **The `far` canvas** (castle, crag, mountains, mist banks, cloud veil) takes no shade and no mist: those things
  are painted in their own airy colours.
- **The wind is strong** (`WIND` in `paint.ts`, `uWind`): gusts cross the valley in bands (`gustAt`). A dab is
  pushed downwind by its kind's `gust` and flutters by its `sway`, times its own `bend` (0 for bark, more at the
  top of a fir). Grass bends from its foot. Shade is asked where a dab is pinned, not where the wind has it.
  `buildFlyingLeaves` is a box of torn-off leaves round the eye. The sky turns with the wind (`SKY_TURN` in
  `main.ts`), so `skyAt` mixes its seam behind the start (`SKY_SEAM`).
- **Lying strokes get a depth step** (`uDepthStep` in the dab shader): each is moved toward the eye by its own
  small amount of clip depth, so strokes that overlap on one surface never fight for depth far away. Do not turn
  `depthWrite` off for things in the valley: they must hide each other.
- **Far strokes are `layered`** (`far` and `sky` in `KINDS`): they leave no depth and are laid far to near, in the
  order they are pushed. A depth is too coarse out there: with one each, overlapping strokes change places
  whenever the eye moves and the picture flickers. Push new far things in far to near order.
- **A mark fills about half of its card.** Solid things are covered several times over (`cover` in `SolidStyle`).
  A crown hides its under blob with lobes of leaves and two dark dabs behind each lobe.
- **Dabs are kept in a few meshes by how they behave** (`KINDS` in `world.ts`): least and largest size on
  screen in reference pixels (270 on the short side), sway, broken colour, shade and mist.
- **Far dabs:** each dab has a fixed rank. Past the distance where it would be smaller than its least size, only
  the low ranks stay and grow. The vertex shader uses true distance, so turning the head changes nothing.
  A stroke that is small on screen is plain (`uFine`): less broken colour, no streak or thickness, and the plain
  mark of the brush sheet (its alpha channel: the same touch as one clean shape, no bristle gaps or dry end).
  Detail inside a stroke a few pixels wide is noise, and far things then read as a mix of colours.
- **How fine a thing is painted** depends on how near the player can come (`reachOf` in `world.ts`).
- **Under meshes** take the light from face normals. Custom geometry must be wound outward.
- **Colours** never go through `THREE.Color`. `hex()` keeps raw sRGB and the renderer converts nothing.
- **Layout** is in world units (metres). The player starts at `z = 14` and looks toward `-Z`. Tables of paths,
  meadows, houses, towers and peaks sit next to the code that uses them in `world.ts`.
- **Creatures** (`mobs.ts`) are the only things that move through the world. A kind's five parts (body, arms,
  legs) are painted once with `paintSolid` round their joints; every creature of the kind shares those
  geometries and has its own pair of materials (`uFlash` flares it when it is struck). The dab shader turns
  strokes and normals with `modelMatrix`. Paint a moving thing with a light that does not depend on where it
  faces (`lightOf: fromAbove`): the baked sun would turn with it. Never scale a creature's group: dab sizes
  are in metres and do not follow the matrix. Build a larger kind instead (`scale` in `KINDS`).
- **Sound** (`audio.ts`): nothing exists before the player touches the page (`unlock`). Add a sound as a WAV
  (mono, 22050 Hz, 16-bit) in `public/audio`, a line in its `CREDITS.md` and an entry in `SOUNDS`. Only CC0
  recordings. Loops must be cut seamless. The game only says what happened (`audio.play`); loudness, takes
  and pitch are in `audio.ts`. The gusts heard are the gusts seen: `gustAt` in `paint.ts` mirrors the shader.
- **Game state** is in `player` (`main.ts`) and in each `Mob`. Events between them are return values:
  `mobs.update()` returns the damage dealt, `hands.update()` returns `struck`. `window.game.mobs.list` shows them.
- Per-frame work is the player step, the creatures, the sparks and two render calls. `window.game.counts` shows the dab counts.

## hand sprites

The hands are cut from the reference frame, not modelled. One sprite pixel is one reference pixel.

```
reference crop + magenta margin ──▶ image model: keep the hand, flat #FF00FF elsewhere, extend the arm
   ──▶ assets/torch-source.jpg, assets/sword-source.jpg
   ──▶ bun scripts/cut-sprite.ts <source> <output.png> <width> <height>   (key, downscale to the pixel grid, 40 colours)
   ──▶ public/sprites/torch.png (150 x 312), public/sprites/sword.png (135 x 412)
```

```bash
bun scripts/cut-sprite.ts assets/torch-source.jpg public/sprites/torch.png 150 312
bun scripts/cut-sprite.ts assets/sword-source.jpg public/sprites/sword.png 135 412
```

Sprite layouts (margins past the screen corner, flame rectangle, sword pivot) are the `TORCH` and `SWORD`
tables in `src/viewmodel.ts`. Update them when a sprite changes size.

The hands walk as in the reference clip (`WALK` in `src/viewmodel.ts`): both sway to the same side together and
each dips at the ends of its swing. The numbers are measured, not tuned: the sprites were laid over every frame
of the clip (best offset by mean colour difference) and the paths fitted with two harmonics of the walk cycle.
The clip's camera does not bob: its background only drifts slowly, so all the life of the walk is in the hands.
`WALK_CADENCE` in `main.ts` is the clip's cycle, 0.87 s for two steps.

## checking the look

`window.game` is a debug hook (`src/main.ts`):

```js
game.snap({ x: 0, z: 14, yaw: 0, pitch: -0.05 }) // place the player, returns a PNG data URL of the frame
game.manual = true; game.stick.y = -1; game.tick(1 / 24) // step frame by frame while walking forward
```

Compare `snap` output with frames of the reference video side by side. Keep the palette measured, not guessed.
