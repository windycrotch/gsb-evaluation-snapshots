# AGENTS.md

Instructions for a coding agent working on this repository. If you are making a video for a user, you want the skill in [skills/motlab/SKILL.md](skills/motlab/SKILL.md), and for assets [skills/motlab-assets/SKILL.md](skills/motlab-assets/SKILL.md), not this file.

## Read first

- [README.md](README.md): what motlab is
- [docs/rendering.md](docs/rendering.md): how a render works and the measured quirks that shaped it
- [CONTRIBUTING.md](CONTRIBUTING.md): what a change must include

## Rules

1. Keep it small. Build the smallest thing that works. No new dependency, cache, validator or abstraction unless a real video needs it or the maintainer asks for it.
2. Docs move with the change, in the same commit: the doc in `docs/` that owns the behaviour, the README if its claims change, `SKILL.md` if the agent uses it, and `CHANGELOG.md`. Grep for the old claim before committing.
3. Numbers carry their measurement: what was rendered, at what size, on what machine.
4. Say what was not tested, and keep [ROADMAP.md](ROADMAP.md) honest.
5. Do not break the page contract or `project.json` for existing projects without saying so in the changelog.
6. Do not commit generated output (`out/`, renders, `selection.json`, `selection/`) or files from a user's project.
7. The viewer follows [DESIGN.md](DESIGN.md). Its UI text is in Indonesian and English: a new string goes into `TEXT` in `src/editor.html` in both.

## Checks before you finish

```bash
npm test
motlab doctor
```

For viewer changes, start `motlab edit example`, check the change in a browser and read the console. For renderer changes, time `motlab render example --scale 1` before and after.

## Installing motlab for a user

Follow [docs/install-for-agents.md](docs/install-for-agents.md).
