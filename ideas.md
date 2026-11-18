# AeroFlap — Design Brainstorm

## Three Directional Approaches

### Theme Name: Sunlit Paper Skies
**Very Brief Intro:** A tactile illustrated flying game with warm paper texture, cloud cut-outs, and a brave little aircraft. It feels optimistic, crisp, and immediately playable rather than overtly nostalgic.
**Probability:** 0.07

### Theme Name: Night-Run Aerodrome
**Very Brief Intro:** A dark runway dashboard, punctured with phosphorescent navigation lights and stormy cloud silhouettes. It would make each run feel tense and instrumental.
**Probability:** 0.04

### Theme Name: Coastal Wind Journal
**Very Brief Intro:** A breezy travel-sketch aesthetic inspired by aviation logbooks and Mediterranean seascapes, using soft blue fields and stamped waypoints. It would position every flight as a miniature expedition.
**Probability:** 0.08

## Chosen Direction: Sunlit Paper Skies

### Design Movement
Contemporary editorial illustration with mid-century travel-poster cues and paper-cut diorama depth. The game world is a bright sky atlas rather than a generic arcade clone.

### Core Principles
1. **Immediate flight clarity:** The avatar, obstacles, score, and primary action always have a high-contrast silhouette.
2. **Tactile layering:** Clouds, hills, pipes, and interface panels use stacked edges, restrained shadows, and printed-grain texture.
3. **Aviation-logbook character:** UI labels use compact coordinates, flight stamps, and altitude motifs rather than generic gaming chrome.
4. **Playful restraint:** One energetic accent color drives action; the rest of the scene remains sunlit, calm, and purposeful.

### Color Philosophy
The main scene uses **high-key sky blue and warm ivory** to feel spacious and friendly. Ink navy supplies reliable contrast against the luminous background, while vermilion is reserved for flight controls, the aircraft wing, and moments of consequence. Verdant green creates the obstacle rhythm without turning the scene into a flat pipe field.

### Layout Paradigm
The game uses a tall, poster-like flight window placed in an asymmetrical airfield frame. A narrow left instrumentation rail carries brand and score context on desktop, while the main canvas is the dominant visual artifact. On smaller screens, the frame collapses to an edge-to-edge cockpit view.

### Signature Elements
1. A vermilion paper plane with a stamped wing stripe and tiny pilot window.
2. Layered ivory cloud bands drifting behind each obstacle field.
3. Coordinate capsules and an altitude-rule score marker that make game stats feel like a flight log.

### Interaction Philosophy
Input should feel like a decisive aircraft control: a click, tap, Space, or Arrow Up gives one clean lift. The start state invites action without a menu maze; failure immediately presents a clear re-flight action while preserving the best score.

### Animation
The plane follows a buoyant spring-like pitch: it tilts upward on thrust and gradually noses down as gravity takes hold. Background cloud bands drift slowly while the obstacle field glides at a steady pace. Score events use a small upward nudge and a brief sunburst, constrained to 160–260ms. All nonessential motion is disabled for reduced-motion preferences.

### Typography System
**Space Grotesk** is the display and control typeface: square, technical, and friendly at bold weights. **DM Mono** supports coordinates, scores, and compact aviation data. Headlines use tight tracking and title case; numbers use tabular monospace for stable score reading.

### Brand Essence
**AeroFlap is the bright, tactile endless-flying challenge for players who want a quick test of timing with an aviation-journal soul.**

**Personality adjectives:** buoyant, precise, adventurous.

### Brand Voice
Headlines are short and propulsive; CTAs use imperative, flight-oriented verbs; microcopy sounds like a calm co-pilot rather than a hype announcer.

> “Clear the clouds. Keep the line.”

> “Wings ready — tap to lift.”

### Wordmark & Logo
The wordmark is a compact geometric **AEROFLAP** lockup with the crossbar of the “A” expressed as a paper-plane wing. The icon is a bold, red folded wing inside an ivory altitude circle; it contains no text and retains a clear silhouette at small sizes.

### Signature Brand Color
**Aero Vermilion — #F24A2E.**

## Style Decisions

- Avoid purple gradients, soft glass cards, and generic rounded app panels.
- Use dark ink text over the bright sky visual treatment for dependable contrast.
- Keep all gameplay logic responsive to keyboard, mouse, and touch input.
- The first visible screen must include the poster-like flight window, asymmetrical instrument rail, AeroFlap wordmark, and tactile paper-cut cloud layer; a flat sky alone is not acceptable.
- Aero Vermilion `#F24A2E` is reserved for the aircraft, primary actions, and score/consequence moments rather than decorative filler.
- Interface labels use calm co-pilot language and compact flight terminology.
