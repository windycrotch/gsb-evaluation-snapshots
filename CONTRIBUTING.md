# Contributing to AeroFlap

Thank you for improving AeroFlap. This project is a browser game, so every contribution should protect input responsiveness, gameplay readability, and the Sunlit Paper Skies visual language.

## Local setup

Use Node.js 22 and pnpm. Install the exact lockfile-resolved dependency graph and start the development server with the repository scripts:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Before proposing a change, run the production checks:

```bash
pnpm check
pnpm build
```

## Development expectations

Create a focused branch such as `feat/weather-gates` or `fix/score-reset`. Keep flight rules in `client/src/game/`, retain the lifecycle boundary between React and Babylon.js, and do not add secrets, build output, or generated runtime media to the repository tree.

Use the existing Prettier configuration before committing:

```bash
pnpm format
```

## Pull requests

Pull requests should explain the gameplay or interface change, identify user-visible behavior, and include the commands run. For changes affecting the live game, include a short note on keyboard, pointer, and touch behavior. The repository owner reviews contributions through the configured code-owner rule.

## Commit messages

Prefer concise Conventional Commit-style messages such as `feat: add crosswind gates`, `fix: preserve best score`, or `docs: clarify demo mode`. Keep commits focused enough to review and revert independently.
