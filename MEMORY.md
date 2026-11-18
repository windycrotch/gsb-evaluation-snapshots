# AeroFlap Build Notes

- The browser game runs as a full-screen Babylon canvas inside a React lifecycle shell.
- Art direction is **Sunlit Paper Skies**: editorial paper-cut layers, a high-key sky, ink-navy UI, and Aero Vermilion as the action color.
- All image assets are generated and referenced through persistent project storage URLs rather than copied into the repository.
- `?demo` is reserved for visual validation and starts a deterministic automatic flight sequence.
- Browser validation confirmed that the first screen contains the full generated paper-cut sky backdrop, a left logbook rail, score dial, wordmark, and launch prompt. The generated secondary sprite URLs may briefly display their platform-provided loading placeholders before their final art replaces them.
- GitHub topic research confirmed active, implementation-aligned discovery categories for `webgl`, `babylon`, `typescript`, `game-development`, and `react-game`; only tags directly supported by the codebase will be applied.
- The Customization Studio entry point was visually verified on desktop and mobile. It occupies the upper-right flight deck on desktop and moves to the lower-right clear space on mobile without covering the main launch prompt.
- The studio’s `?studio` verification mode confirms that color, background-mode, pace, gate-opening, and volume controls render in a scrollable panel on desktop and mobile. The normal game keeps the panel closed by default.
