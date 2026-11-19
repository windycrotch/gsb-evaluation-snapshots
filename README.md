# castle-valley

A playable three.js game: you walk out of a dark forest, torch and sword in hand, toward a
village under a castle, and fight the goblins and trolls on the way. It recreates this pixel-art clip:
https://x.com/de5imulate/status/1947024682118488116

**Play it:** https://omw-game.kimaki.dev

```bash
pnpm install
pnpm dev
```

| input | desktop | touch |
| --- | --- | --- |
| look | click, then move the mouse | drag the right half |
| walk | `WASD` or arrows, `shift` runs | drag the left half |
| jump | `space` | the JUMP button |
| swing | click, `F` or `E` | tap the right half |
| mute | `M` | |

## Creatures

Packs of **goblins** and a few **trolls** roam the meadows and the paths (`src/mobs.ts`).

- They see you from about 17 m, run at you and raise a club. Step back or jump before it comes down.
- A swing of the sword strikes everything in reach before you. A goblin takes three blows, a troll nine.
- You have five hearts. They show while you are hurt and come back when no blow has landed for a while.
- Struck down, you start again at the forest and every creature is back at its home.

## Sound

Short, dry recordings in the manner of an old game (`src/audio.ts`, files in `public/audio`): steps on grass
and on the path, the sword, the club, the cries of the creatures. Each play is pitched a little by chance, and
a troll has a goblin's voice played slower. A creature is heard from where it stands: quieter with distance,
and to the left or right. The wind is as loud as the gust that passes, and a song plays far under it all.

## How it looks painted

The whole world is made of **dabs**: single marks of a bristle brush, pinned to points in 3D. No filter makes
the strokes. The painter follows https://patch.gg/blendi/oil-paint.

```
under ── coarse geometry in flat colours: the underpainting, so nothing shows between the dabs
dabs ─── about 2.5 million instanced cards, each one mark of the brush sheet in one mixed colour
          face: turns to the eye and runs along a direction (leaves, bark, boughs, grass, cloud)
          lie:  lies on its surface and runs along its grain (ground, walls, roofs, rock)
```

- **Pinned to the world.** A dab never moves, so the paint stays on things when you walk or turn.
- **The brush** is a sheet of eight marks made in code (`src/brush.ts`): long strokes that run dry, curved
  strokes, pressed dabs. A light from the upper left rakes across the thick paint.
- **Colours are mixed once**, when the world is built: a tone from a ramp, picked by light and chance. The ramps
  are measured from the reference video (`RAMPS` in `src/paint.ts`).
- **Each kind of thing has its painter** (`src/things.ts`): lobes of leaves round a dark core, bark up a trunk,
  boughs that hang from a fir, strokes along the grain of a wall, flicks of grass.
- **Sun and shade.** The valley's shade is drawn once from the sun. A dab takes sun or shade whole, so the
  edge of a shadow is a ragged line of whole dabs.
- **Wind.** Gusts cross the valley in bands: leaves and firs are pushed downwind, grass bends, torn-off leaves
  fly past, and the clouds drift.
- **Mist** puts distance between one row of things and the next: each dab fades by its distance from you.
- **The finish** runs once over the picture (`src/main.ts`): a colour grade that leans the shade to violet and
  the light to warm yellow, the weave of the canvas, and a little varnish. It also smooths and then firms the
  edges of the strokes. The picture is drawn at the screen's own pixels, and with fewer when frames are slow.
- **Far away, fewer and larger dabs.** Each dab has a fixed rank. With distance only the low ranks stay and
  grow to cover their neighbours, so strokes never swap. Small strokes use a plain variant of the
  brush: one clean shape in one colour.

- **Creatures are painted the same way.** Each part of a body is painted once and moves as a whole, so the
  strokes stay on the creature as it walks. It is lit from straight above, which stays right as it turns.

The hands and the hearts are **pixel sprites** drawn over the world, like Doom weapons. The hands are cut from
the reference frame.

## Deploy

The game is a static site on Cloudflare Workers (`wrangler.jsonc`): no Worker code, only the files vite builds.

```bash
pnpm run deploy        # preview, on workers.dev
pnpm run deploy:prod   # https://omw-game.kimaki.dev
```

See `AGENTS.md` for the code layout.
