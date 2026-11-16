# Installing motlab

motlab has two parts: the engine (the `motlab` command, the viewer and the renderer) and two agent skills: `skills/motlab/` makes videos, and `skills/motlab-assets/` makes reusable asset kits for them. The installer sets up both parts. If an agent is doing the install for you, point it at [install-for-agents.md](install-for-agents.md).

## Requirements

| Tool | Why | Check |
|---|---|---|
| Node.js 24 or newer | runs the engine | `node --version` |
| Google Chrome or Chromium | draws and encodes the frames | found on its default path, or set `CHROME` |
| ffmpeg and ffprobe | join the parts, add audio, check the output | `ffmpeg -version` |
| Python 3, optional | the skills' helper scripts | `python --version` |
| Blender 4.2 or newer, optional | the main 3D path of `motlab-assets` (FBX, baked textures, Cycles stills) | `blender --version` |

How to get them:

| | Windows | macOS | Debian or Ubuntu |
|---|---|---|---|
| Node 24 | `winget install OpenJS.NodeJS` | `brew install node` | [nodejs.org](https://nodejs.org) or nvm |
| Chrome | `winget install Google.Chrome` | `brew install --cask google-chrome` | Google's `.deb`, or `sudo apt install chromium` |
| ffmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |
| Python 3 | `winget install Python.Python.3.12` | `brew install python` | `sudo apt install python3 python3-pip` |

The skill's scripts need numpy, scipy and Pillow:

```bash
python -m pip install -r skills/motlab/requirements.txt
```

## With the installer

```bash
git clone https://github.com/staryone/motlab.git
cd motlab
node install.js
```

It does four things and prints each one:

1. `npm ci` in the engine folder. The only dependency is `mediabunny`, pinned to an exact version.
2. Writes a `motlab` launcher to `~/.local/bin` (on Windows `motlab.cmd` for cmd and PowerShell, and `motlab` for Git Bash). The launcher runs `bin/motlab.js` from the folder you cloned, so keep that folder where it is. If `~/.local/bin` is not on PATH, the installer prints the line that adds it.
3. Copies both skills to each agent skill folder you pick.
4. Runs `motlab doctor` and lists anything still missing.

It keeps where the skills, the launcher and `--link` went in `~/.motlab/install.json`, so `motlab update` can put them back there.

Options:

| Option | Meaning |
|---|---|
| `--skill <target>` | where the two skills go, from the table below. Several at once with commas: `--skill claude,agents,antigravity`. The default is `claude` |
| `--skill none` | engine and command only |
| `--skill-dir <dir>` | the skills in any other folder, for an agent not in the table. Can be given more than once, and together with `--skill` |
| `--link` | link the skill folders to this checkout instead of copying them, so edits under `skills/` apply at once (a junction on Windows) |
| `--bin <dir>` | put the launcher somewhere else |
| `--update` | the skills again in every folder from `~/.motlab/install.json`, and in any folder from the table below that already has the motlab skill (an install from before that file). `--skill` and `--skill-dir` add folders. `motlab update` runs this |
| `--force` | replace a folder at a skill path that has no `SKILL.md` |
| `--dry-run` | print every step and change nothing |

Skill targets. Each one is the agent's user skill folder, as its docs gave it in November 2026:

| Target | Folder | Read by |
|---|---|---|
| `claude` | `~/.claude/skills/` | Claude Code. Cursor, OpenCode and Amp read it too |
| `agents` (or `codex`) | `~/.agents/skills/` | Codex, Cursor, OpenCode, GitHub Copilot, Gemini CLI, Amp, Windsurf |
| `antigravity` | `~/.gemini/config/skills/` | Antigravity, the App and the CLI |
| `opencode` | `~/.config/opencode/skills/` | OpenCode |
| `cursor` | `~/.cursor/skills/` | Cursor |
| `copilot` | `~/.copilot/skills/` | GitHub Copilot |

`claude,agents,antigravity` covers every agent in the table. An agent that reads two of these folders finds the skill in both; OpenCode and Amp keep one, and the others may list it twice. For any other agent, find its user skill folder in its docs and pass it with `--skill-dir`, for example Windsurf's own `~/.config/devin/skills`. The Antigravity CLI also reads `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/`, and the App reads neither, so the installer uses the folder they share. A copy in one of the CLI's own folders wins over it in the CLI, so delete an old one there. Codex used `~/.codex/skills/` before; a copy left there by an older installer can be deleted.

The installer never installs Chrome, ffmpeg or Python. An existing link at a skill path is removed as a link, so the folder it pointed at is not touched. A folder there that has no `SKILL.md` is left alone unless you pass `--force`.

## Without the installer

```bash
git clone https://github.com/staryone/motlab.git
cd motlab
npm ci
node bin/motlab.js doctor
```

Then either run `node /path/to/motlab/bin/motlab.js` directly, or make a launcher yourself. On Windows, `motlab.cmd` containing `@node "C:\path\to\motlab\bin\motlab.js" %*` in a folder on PATH. On macOS and Linux, a `motlab` file containing `exec node "/path/to/motlab/bin/motlab.js" "$@"`, marked executable.

`npm link` and `npm install -g .` also work where npm's global folder is on PATH. They do not with nvm for Windows in its default setup, which is why the installer writes its own launcher.

To install the skills by hand, copy or link `skills/motlab/` and `skills/motlab-assets/` to your agent's skill folder (see the table above), side by side. Both call `motlab` and find the engine folder through `motlab --help`; `motlab-assets` also uses scripts from the motlab skill there.

## Updating

```bash
motlab update
```

It works in the clone the `motlab` command runs from:

1. Stops if the clone has changes to tracked files, is not on a branch, or has commits that GitHub does not. It says what to do about each.
2. Fetches the branch from `origin` and lists the new commits. With none it says so and stops.
3. Fast-forwards to them (`git merge --ff-only`), so it never makes a merge commit.
4. Runs the new `install.js --update`: `npm ci`, the launcher, and the skills copied again to every folder they were installed in, then `motlab doctor`.

`motlab update --dry-run` fetches and lists the new commits, then prints the other steps without doing them. A viewer that is already running keeps the old code until `motlab restart`, and an agent picks up the new skills in a new session.

By hand, the same is:

```bash
cd motlab
git pull
node install.js --update
```

With `--link`, the skills update with `git pull` alone, but run the installer anyway in case the npm packages changed.

## Removing

```bash
motlab uninstall
```

It stops the viewer and removes the launcher (`~/.local/bin/motlab`, and `motlab.cmd` on Windows), the two skill folders in every agent folder they were installed in, `~/.motlab/` (where the installer put things, the viewer's recent projects and its log) and the encoder timings (`%LOCALAPPDATA%\motlab` on Windows, `~/.cache/motlab` elsewhere; with `MOTLAB_CACHE_DIR` only the timings file). It lists everything and asks first; `--yes` skips the question and `--dry-run` only lists. A skill installed with `--link` is removed as a link, and what it points to stays. It leaves the clone, because it runs from there: delete that folder afterwards.

## Check the machine

```bash
motlab doctor
```

It checks Node, Chrome, ffmpeg, ffprobe, the npm packages, and (as warnings) Python and its packages. For each missing tool it prints a command for your OS. The exit code is 1 when a required check fails. The GPU in use is not checked here: every render prints it on its first line.

## Notes per OS

Windows

- Chrome is found in `Program Files` and `Program Files (x86)`. Set `CHROME` for any other path.
- On a laptop with two GPUs, headless Chrome draws on the integrated one unless told otherwise. motlab always passes `--force_high_performance_gpu`, and each render prints the GPU it got.
- Python is usually `python`, not `python3`.

macOS and Linux

- The code has the macOS and Linux Chrome paths and uses ANGLE on Metal on macOS. On Linux, CI runs the tests and their end-to-end renders on an Ubuntu runner with Google Chrome and the distribution's ffmpeg; no real video and no install with `install.js` have been tried there, and macOS has not been tested at all. Reports are welcome.
- A machine without a GPU should still render through Chrome's software drawing and software H.264 encoder, only slower. On the Windows test laptop with Chrome drawing on SwiftShader, the benchmark scene took 2.8 times as long at 1080p and 4.5 times at 4K ([rendering](rendering.md#without-a-gpu)). A machine with no GPU at all has not been tested.
