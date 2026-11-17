# Contributing to Bytebound: Meadow Run

Thank you for helping improve Bytebound: Meadow Run. This repository contains an original browser platformer. Contributions should preserve the project’s original characters, visuals, music, and level design; do not submit copyrighted third-party game content.

## Development setup

Use the package-manager version declared by the repository. From the repository root, install dependencies and start the Vite development server.

```bash
corepack enable
pnpm install
pnpm dev
```

Before opening a pull request, run the repository’s available validation commands.

```bash
pnpm check
pnpm build
```

## Working conventions

Use a focused branch name such as `feature/touch-tutorial` or `fix/mobile-audio`. Keep commits concise and imperative, for example `fix: release touch input on pointer cancel`. Preserve the separation between framework-agnostic gameplay in `client/src/game/`, the Babylon.js scene bridge in `client/src/game/scene.ts`, and React user-interface concerns in `client/src/components/GameCanvas.tsx`.

Describe player-facing effects in each pull request. For gameplay, touch, audio, or mobile-layout changes, include the browser and device class used for manual verification. Please follow the repository’s [Code of Conduct](CODE_OF_CONDUCT.md) and use the provided issue forms for bug reports and feature requests.
