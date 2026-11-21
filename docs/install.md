# Installing motlab

motlab has two parts: the engine (the `motlab` command, the viewer and the renderer) and two agent skills: `skills/motlab/` makes videos, and `skills/motlab-assets/` makes reusable asset kits for them. There are two ways to install both: from npm, or from a clone with the installer. Take npm to use motlab, and the clone to work on it. If an agent is doing the install for you, point it at [install-for-agents.md](install-for-agents.md).

## Requirements

| Tool | Why | Check |
|---|---|---|
| Node.js 24 or newer | runs the engine | `node --version` |
| Google Chrome or Chromium | draws and encodes the frames | found on its default path or in Playwright's browser folder, or set `CHROME` to it |
| ffmpeg and ffprobe | join the parts, add audio, check the output | `ffmpeg -version` |
| Python 3, optional | the skills' helper scripts | `python --version` |
| Blender 4.2 or newer, optional | the main 3D path of `motlab-assets` (FBX, baked textures, Cycles stills) | `blender --version` |

How to get them:

| | Windows | macOS | Debian or Ubuntu |
|---|---|---|---|
| Node 24 | `winget install OpenJS.NodeJS` | `brew install node` | [nodejs.org](https://nodejs.org) or nvm |
| Chrome | `winget install Google.Chrome` | `brew install --cask google-chrome` | Google's `.deb` on x64 (below); on Ubuntu, `apt install chromium` gives the snap, which can fail headless |
| ffmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |
| Python 3 | `winget install Python.Python.3.12` | `brew install python` | `sudo apt install python3 python3-pip` |

Google Chrome on Debian or Ubuntu (x64), the command `motlab doctor` prints when Chrome is missing:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

A machine set up for Playwright needs no other Chrome. When no system Chrome is found, motlab uses the newest Chromium that `npx playwright install chromium` put in Playwright's folder: `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows, or `PLAYWRIGHT_BROWSERS_PATH` when it is set. For a Chrome anywhere else, set `CHROME` to it.

The skill's scripts need numpy, scipy and Pillow. From the engine folder (`motlab --help` prints it; `motlab doctor` prints this command with the full path when they are missing):

```bash
python -m pip install -r skills/motlab/requirements.txt
```

[earshot](https://github.com/Leonxlnx/earshot) is optional. With it the agent can listen to sound: pick sound effects, find the best moment in a recording and check a mix. It needs Python with torch and about 1.1 GB of models, so motlab never installs it. `motlab doctor` shows it as `ok` with its models downloaded, or as `warn` with what to do, and it never makes the doctor fail. Install it from its own page, then `earshot doctor --fetch` downloads the models.

## From npm

```bash
npm install -g @motlab/cli
npx @motlab/cli setup
```

npm installs the engine and its one dependency and makes the `motlab` command. Setup copies both skills to an agent skill folder (Claude Code by default) and runs `motlab doctor`. It takes the skill options of the installer below: `--skill`, `--skill-dir`, `--link`, `--update`, `--force` and `--dry-run`, so `npx @motlab/cli setup --skill claude,agents` puts the skills in two places. It is run through npx because `motlab` may not be on PATH yet; npx runs the installed package and downloads nothing. Once the command works, `motlab setup` is the same. The engine folder is inside npm's global folder; `motlab --help` prints it, and the example project is in it.

The command only works if npm's global folder is on PATH. `npm prefix -g` prints that folder (on Windows the command goes in it, elsewhere in its `bin`). With the Node installer from nodejs.org or Homebrew it is on PATH already. With nvm for Windows 2.0 in its default shim mode it is not: npm puts the command in the Node version's own folder (`installs\v24.x`), and nvm's `.shim` folder only holds the shims nvm ships with (node, npm, npx, pnpm, corepack, codex), so `motlab` is not found. Setup sees this and writes its own `motlab` launcher to `~/.local/bin`, as the clone installer does (`--bin <dir>` puts it elsewhere), and prints the line that adds that folder to PATH if it is not there. The launcher runs the engine in npm's folder, so `npm install -g @motlab/cli@latest` updates it, and `motlab uninstall` removes it. An older launcher there, from a clone, is replaced, and setup says what it ran.

Instead of the launcher, npm's global folder can point at one that is on PATH, once, before installing:

```bash
npm config set prefix "%APPDATA%\npm"
```

In PowerShell write `"$env:APPDATA\npm"`. `%APPDATA%\npm` is npm's usual global folder on Windows and is often on PATH from an earlier Node install; `where npm` lists it if so, otherwise add it to PATH. This changes where every global package goes, not only motlab, and the packages there are shared by all Node versions. `motlab update` keeps working, because its `npm install -g` follows the same setting. The clone below also works there, since its installer writes its own launcher.

This was tested on Windows 11, from the registry and from a packed tarball, each installed into a separate npm folder: `setup`, `update`, `uninstall` and a render of the example. It was also installed globally with nvm for Windows 2.0: `npx @motlab/cli` ran the installed package from the nvm folder, setup wrote the launcher when that folder was off PATH and none when it was on PATH, and with the prefix in `%APPDATA%\npm` the command was found without one. On a Linux VPS (Ubuntu, 2 cores, no GPU, npm's prefix in `~/.npm-global`), a packed tarball installed globally ran `setup` without writing a launcher, `which motlab` found npm's own command, `motlab doctor` was ready and the example rendered. It has not been tried on macOS.

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
| `--skills-only` | the skills and `motlab doctor`, no `npm ci`, and a launcher only for an npm install whose command folder is not on PATH. `motlab setup` runs this |
| `--dry-run` | print every step and change nothing |

Skill targets. Each one is the agent's user skill folder, as its docs gave it in November 2026:

| Target | Folder | Read by |
|---|---|---|
| `claude` | `~/.claude/skills/` | Claude Code. Cursor, OpenCode and Amp read it too |
| `agents` (or `codex`, `muse`) | `~/.agents/skills/` | Codex, Cursor, OpenCode, GitHub Copilot, Gemini CLI, Amp, Windsurf, Muse Code |
| `antigravity` | `~/.gemini/config/skills/` | Antigravity, the App and the CLI |
| `hermes` | `skills/` in Hermes's home: `HERMES_HOME` if set, else `~/.hermes/` (`%LOCALAPPDATA%\hermes\` on Windows) | Hermes Agent |
| `opencode` | `~/.config/opencode/skills/` | OpenCode |
| `cursor` | `~/.cursor/skills/` | Cursor |
| `copilot` | `~/.copilot/skills/` | GitHub Copilot |

`claude,agents,antigravity,hermes` covers every agent in the table. An agent that reads two of these folders finds the skill in both; OpenCode and Amp keep one, and the others may list it twice. Muse Code also reads `~/.claude/skills/`, so after `claude,agents` it may list motlab twice. Hermes reads `~/.agents/skills/` only when it is listed under `skills.external_dirs` in its `config.yaml`; `--skill hermes` copies the skills into its own folder instead. A Hermes profile has its own home, so run setup with that profile's `HERMES_HOME` set to put the skills there. For any other agent, find its user skill folder in its docs and pass it with `--skill-dir`, for example Windsurf's own `~/.config/devin/skills`. The Antigravity CLI also reads `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/`, and the App reads neither, so the installer uses the folder they share. A copy in one of the CLI's own folders wins over it in the CLI, so delete an old one there. Codex used `~/.codex/skills/` before; a copy left there by an older installer can be deleted.

The installer never installs Chrome, ffmpeg or Python. An existing link at a skill path is removed as a link, so the folder it pointed at is not touched. A folder there that has no `SKILL.md` is left alone unless you pass `--force`.

## Without the installer

```bash
git clone https://github.com/staryone/motlab.git
cd motlab
npm ci
node bin/motlab.js doctor
```

Then either run `node /path/to/motlab/bin/motlab.js` directly, or make a launcher yourself. On Windows, `motlab.cmd` containing `@node "C:\path\to\motlab\bin\motlab.js" %*` in a folder on PATH. On macOS and Linux, a `motlab` file containing `exec node "/path/to/motlab/bin/motlab.js" "$@"`, marked executable.

`npm link` and `npm install -g .` also work where npm's global folder is on PATH, as `npm install -g @motlab/cli` does. They do not with nvm for Windows 2.0 until npm's prefix is changed (above), which is why the installer writes its own launcher.

To install the skills by hand, copy or link `skills/motlab/` and `skills/motlab-assets/` to your agent's skill folder (see the table above), side by side. Both call `motlab` and find the engine folder through `motlab --help`; `motlab-assets` also uses scripts from the motlab skill there.

## Updating

```bash
motlab update
```

From npm, `motlab update` asks npm for the newest version. If there is one, it prints the two commands that get it:

```bash
npm install -g @motlab/cli@latest
motlab setup --update
```

The second copies the skills again to every folder they went to before, since npm only replaces the engine.

From a clone, it works in the clone the `motlab` command runs from:

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

It stops the viewer and removes the launcher (`~/.local/bin/motlab`, and `motlab.cmd` on Windows), the two skill folders in every agent folder they were installed in, `~/.motlab/` (where the installer put things, the viewer's recent projects and its log) and the encoder timings and cached scene parts (`%LOCALAPPDATA%\motlab` on Windows, `~/.cache/motlab` elsewhere; with `MOTLAB_CACHE_DIR` only the timings file). It lists everything and asks first; `--yes` skips the question and `--dry-run` only lists. A skill installed with `--link` is removed as a link, and what it points to stays. It leaves the clone, because it runs from there: delete that folder afterwards. From npm there is no launcher to remove, and `npm uninstall -g @motlab/cli` removes the engine and the command afterwards.

## Check the machine

```bash
motlab doctor
```

It checks Node, Chrome, ffmpeg, ffprobe, the npm packages, and (as warnings) Python and its packages. For each missing tool it prints a command for your OS. The exit code is 1 when a required check fails. The GPU in use is not checked here: every render prints it on its first line.

## Notes per OS

Windows

- Chrome is found in `Program Files` and `Program Files (x86)`, then in Playwright's folder. Set `CHROME` for any other path.
- On a laptop with two GPUs, headless Chrome draws on the integrated one unless told otherwise. motlab always passes `--force_high_performance_gpu`, and each render prints the GPU it got.
- Python is usually `python`, not `python3`.

macOS and Linux

- The code has the macOS and Linux Chrome paths and uses ANGLE on Metal on macOS. On Linux, CI runs the tests and their end-to-end renders on an Ubuntu runner with Google Chrome and the distribution's ffmpeg. A real video has been made there now: a 42 s, 1080x1920 project on Ubuntu 24.04 with no GPU, rendered in about 82 s with the Chromium Playwright downloads (`CHROME` set to `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`), and an install from a clone with `install.js` worked too (issue #8). An install from the npm registry on Linux has not been tried, and macOS has not been tested at all. Reports are welcome.
- A machine without a GPU renders through Chrome's software drawing and software H.264 encoder, only slower: the Linux render above took about 82 s for 42 s of video at 1080x1920, and on the Windows test laptop with Chrome drawing on SwiftShader, the benchmark scene took 2.8 times as long at 1080p and 4.5 times at 4K ([rendering](rendering.md#without-a-gpu)). No 3D (WebGL) scene has been rendered on a machine without a GPU yet.
