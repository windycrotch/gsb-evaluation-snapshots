# Contributing

Thanks for looking. motlab stays small on purpose: build the smallest thing that works, and add a feature when a real video needs it.

## Setup

```bash
git clone https://github.com/staryone/motlab.git
cd motlab
node install.js --link     # the skills link to this checkout, so edits apply at once
motlab doctor
npm test
```

## Repository shape

```text
bin/motlab.js          the command
src/                   engine: CLI, Chrome over CDP, render, encoder probe, ffmpeg, project, viewer server
src/page/              code that runs inside Chrome: the render runtime, footage, cut lists, motion and transitions
src/editor.html        the viewer, one file (its design is in DESIGN.md)
skills/motlab/         the video skill: SKILL.md, references, templates, helper scripts
skills/motlab-assets/  the asset skill: kits of 2D and 3D assets built as code
example/               a sample project
test/                  node:test, including an end-to-end render
docs/                  install, projects, viewer, command line, rendering
bench/                 one scene timed in motlab, Remotion and HyperFrames
install.js             the installer
assets/                the demo preview at the top of the README
```

The code is plain JavaScript ESM with JSDoc, no TypeScript and no build step, because half of it runs inside Chrome straight from disk. The only npm dependency is `mediabunny`, pinned to an exact version (`.npmrc` has `save-exact`). Think twice before adding another.

## Rules for a change

1. Docs move with the code in the same commit. A new flag, field or behaviour updates the README or the doc in `docs/` that describes it, `SKILL.md` if the agent uses it, and `CHANGELOG.md`. A doc that describes something the code does not do is a bug.
2. Numbers come with what produced them. "Faster" is not a change note; "1080p, 200 frames, 2.9 s to 2.1 s on an RTX 3060 laptop" is.
3. Say what you did not test. The [roadmap](ROADMAP.md) keeps the list of what has not been tried, and a change that tests one of those items removes it.
4. Do not commit generated output: `out/`, renders, `selection.json`, `selection/`.
5. The viewer follows [DESIGN.md](DESIGN.md). Its text is in Indonesian and English, in the `TEXT` table at the top of its script; a new string needs both, short and in the same voice. `test/editor-text.test.js` checks that every key the page uses is there in both.
6. A change to the page contract or `project.json` must keep existing projects working, or say clearly in the changelog what breaks.
7. A skill's `name` matches its folder and its `description` stays at 500 characters or less, or Codex and other agents skip it without a word. `test/skills.test.js` checks both.

## Tests

```bash
npm test
```

`test/codecs.test.js` checks the frame maths. `test/render.test.js` renders `test/fixtures/basic.html` through every path (default encoder, software, raw mux, three workers, audio, stills, events) and checks the frame count, duration, colour tags and decoded colour values. It also renders a WebM footage clip, two scenes from sections of one recording, projects with a transition, with a transition from a `.glsl` file and with scenes of different sizes, a project again with `--only`, and a project three parts at a time with one part failing. It needs Chrome and ffmpeg. The others need neither: `motion.test.js` checks the easings, springs, keyframes, transition names and how a `.glsl` transition's uniforms are read, `cli.test.js` that `motlab help`, `--help` and `-h` print the commands and that `motlab working` checks its numbers, `doctor.test.js` the optional earshot check, `chrome.test.js` the `--no-sandbox` flag and the lookup of Playwright's Chromium, `server.test.js` that a file stream closes when its request is aborted, `access.test.js` the viewer's login on a domain, `live.test.js` the viewer's live updates, `install.test.js` what setup, `--update` and uninstall write and remove, `cuts.test.js` how cut list sections and captions are placed, `notes.test.js` how the viewer's notes merge into `selection.json`, `skills.test.js` the skills' frontmatter, and `editor-text.test.js` the viewer's `TEXT` table.

If you touch the renderer, include the render time of the sample project before and after: `motlab render example --scale 1`.

For viewer changes, run `motlab edit example`, check the change in a browser, and look at the console for errors.

## Pull requests

Before you start on something bigger than a fix, such as an item from the roadmap, open an issue or comment on one to say you're taking it. That way two people don't build the same thing, and we can agree on the approach first.

One concern per pull request. Describe what changed, what you measured, and what you could not check. Commit subjects are short and imperative, for example `Viewer: keep the box when the time changes`.

## Reporting bugs

Open an issue with the command you ran, the full output, `motlab doctor` output, your OS, and the smallest page or project that shows the problem. Security problems go through [SECURITY.md](SECURITY.md) instead.

## Code of conduct

Be kind and specific. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
