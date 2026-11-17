# Bytebound: Meadow Run — Design Direction

## Three possible directions

### Theme Name: Signal Meadow
**Very Brief Intro:** A sunlit cartridge-era meadow with copper, moss, and teal accents. It feels tactile and optimistic, like a well-loved game manual translated into a living world.
**Probability:** 0.07

### Theme Name: Moonlit Relay
**Very Brief Intro:** A cool midnight route where the courier follows glowing beacons through quiet hills. The mood is focused and atmospheric, with restrained luminous accents.
**Probability:** 0.03

### Theme Name: Foundry Sprint
**Very Brief Intro:** A warm industrial platformer built from rivets, pipes, and signal lamps. The world is punchier and more mechanical, with strong rhythmic geometry.
**Probability:** 0.09

## Chosen direction: Signal Meadow

### Design Movement

The chosen direction is **handcrafted cartridge modernism**: the clarity and reduction of early console platformers, rebuilt with contemporary responsive layout, touch ergonomics, and small moments of material texture.

### Core Principles

1. **Readable before ornamental.** Every collision surface, enemy, collectible, and goal must be readable in one glance.
2. **Small palette, strong rhythm.** A limited palette creates visual memory; contrast is reserved for interactive objects and feedback.
3. **World as a route.** The level is a sequence of invitations, tests, and rewards rather than a decorative backdrop.
4. **Tactile imperfection.** Chunky silhouettes, stepped edges, and tiny screen-like accents should feel authored rather than generically smooth.

### Color Philosophy

The base world is a warm cream and soft sky blue so the game feels welcoming on both a desktop monitor and a phone. Moss green anchors the terrain, copper orange signals reward and momentum, and deep ink provides the outline discipline that makes low-resolution forms legible. The signature brand color is **signal saffron `#F4B942`**, used sparingly for collectibles, portal energy, and active focus states.

### Layout Paradigm

The playfield is an edge-to-edge horizontal instrument rather than a centered card. On wide screens, the game canvas sits inside a dark ink surround with a small asymmetric status rail; on phones, the canvas expands to the safe area and controls dock at the lower corners. Information is clustered near the action instead of distributed into a conventional dashboard.

### Signature Elements

1. **Signal shards:** three-diamond clusters that flash saffron when collected.
2. **Relay pennants:** tiny coral-and-teal checkpoints that fold open when activated.
3. **Stepped hills:** parallax silhouettes built from blocky diagonal stair-steps rather than soft vector curves.

### Interaction Philosophy

Inputs should feel immediate and forgiving. A buffered jump and small coyote window respect the player’s intent without making the game feel floaty. Buttons press inward by a single pixel-like step, keyboard controls remain instant, and pause/restart actions never require searching through a menu.

### Animation

Movement uses short, hand-authored frame loops: two-frame run, one-frame skid, two-frame airborne cycle, and a crisp one-frame landing squash. Parallax layers drift at fixed fractional speeds. Collectibles pulse with a two-step brightness change, checkpoints unfold in three beats, and screen transitions use a quick ink wipe rather than a fade. All nonessential UI motion is disabled under `prefers-reduced-motion`.

### Typography System

Headlines use **Press Start 2P** for the cartridge register; body copy and controls use **Space Grotesk** for clarity on modern screens. Headline text is all-caps with generous tracking, while gameplay labels use compact monospace styling and never rely on color alone.

### Brand Essence

**A bright, original platforming route for players who want the snap of classic games without the museum glass.** Personality: **sunny, precise, plucky**.

### Brand Voice

Headlines are compact and confident. CTAs sound like instructions from a friendly game manual, not generic SaaS copy.

Example lines:

> **RUN THE RELAY.**

> **Catch the next signal.**

### Wordmark & Logo

The mark is a three-step saffron signal shard with one teal notch cut from the lower corner. It reads as a relay beacon at small sizes and a forward arrow at larger sizes. The wordmark is not used as the logo; the mark stands alone in the header, favicon, and HUD.

### Signature Brand Color

**Signal saffron `#F4B942`** — a warm, ownable yellow-orange that marks the game’s energy, rewards, and moments of forward motion.

## Style Decisions

- Use authored procedural canvas art for the first milestone because the image-generation quota is unavailable; keep the palette and geometry modular so generated sprite sheets can replace it later without changing gameplay code.
- Never use Mario, Nintendo, or recognizable third-party character, logo, sound, or level identifiers.
- Terrain language: every major background hill uses blocky stepped diagonals or stair-step silhouettes; smooth generic triangles are not the dominant meadow shape.
- Signal saffron `#F4B942` appears only on rewards, active control states, portal/relay energy, and the logo mark; borders and passive UI lean on ink, cream, moss, teal, or copper.
- Collectibles read as three-diamond signal shard clusters, not single coins, squares, or generic glowing pickups.
