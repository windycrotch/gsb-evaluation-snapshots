# Installing motlab (for an agent)

Follow these steps when a user asks you to install or update motlab. Ask before running any command that installs system software, and never install anything the user did not agree to.

## 1. Check what the machine has

```bash
node --version
ffmpeg -version
ffprobe -version
```

Node must be 24 or newer. If Node is missing or older, tell the user and give them the command from the table in [install.md](install.md#requirements) for their OS. Do the same for Chrome and ffmpeg. Do not continue until Node 24 is there; Chrome and ffmpeg can be fixed after the install, because `motlab doctor` reports them again.

## 2. npm or a clone

Ask which they want. npm is simpler for using motlab; a clone is for working on it.

With npm, pick the skill target as in step 3, then:

```bash
npm install -g @motlab/cli
npx @motlab/cli setup --skill <target> --dry-run
npx @motlab/cli setup --skill <target>
```

Setup takes the same skill options as the installer and runs `motlab doctor` at the end. When npm's command folder is not on PATH (nvm for Windows), it writes a `motlab` launcher to `~/.local/bin`; if it then prints that `~/.local/bin` is not on PATH, show the user the line and ask before changing their PATH. To update later, `motlab update` prints the two commands (`npm install -g @motlab/cli@latest`, then `motlab setup --update`). Then skip to step 4.

## Get the repository

For a clone: if the user has none yet, ask where it should live (a folder they keep, not a temporary one, because the `motlab` command runs from it):

```bash
git clone https://github.com/staryone/motlab.git <folder>
```

If they already have a clone and only want the newest version, run `motlab update` and skip to step 4: it pulls, runs `npm ci` and copies the skills again to every agent folder they were installed in. If it stops because the clone has local changes or commits of its own, show the user its message and ask what to do; do not stash, reset or discard anything yourself.

## 3. Run the installer

Pick the skill target for the agent you are, from the table in [install.md](install.md#with-the-installer): `claude` for Claude Code, `agents` for Codex, Cursor, OpenCode, GitHub Copilot, Gemini CLI, Amp, Windsurf and Muse Code, `antigravity` for the Antigravity App and CLI, `hermes` for Hermes Agent. If the user also works in other agents, ask which, and join the targets with commas. For an agent not in the table, look up its user skill folder in its own docs and pass `--skill-dir <folder>` instead. Run a dry run first and show the user where files will go:

```bash
node install.js --skill <target> --dry-run
node install.js --skill <target>
```

Use `--link` only when the user works on the skill itself. If the installer refuses because a folder without `SKILL.md` is at a skill path, ask the user what to do with it; pass `--force` only when they say so.

If the installer prints that `~/.local/bin` is not on PATH, show the user the line it printed and ask before changing their shell profile or Windows user PATH. Until it is on PATH, call the engine as `node <folder>/bin/motlab.js`.

## 4. Verify

```bash
motlab doctor
motlab --help
```

`doctor` must end with `Ready.` (warnings about Python are fine if the user does not need the skill's scripts). `motlab --help` prints the engine folder; it must be the clone from step 2, or the folder in npm's global `node_modules` for an npm install. If it is another folder, an older launcher comes first on PATH; tell the user which one.

Python packages for the skill's scripts, if the user wants them:

```bash
python -m pip install -r <folder>/skills/motlab/requirements.txt
```

## 5. Tell the user

Say in a few lines what was installed and where (the clone and the launcher, or the npm package, and the two skill folders), what `doctor` still reports, and how to start: `motlab edit <folder>/example` opens the example in the viewer (it starts the viewer in the background) and prints the address, `http://127.0.0.1:4173/p/example/`; `motlab stop` ends it. A new agent session may be needed before the skills show up.

## 6. The viewer on a VPS, when the user asks for it

Only when the user wants to open the viewer from anywhere, for example on their phone, with the viewer running on a server of theirs. Work on the server itself (a Linux VPS reached over SSH), after steps 1 to 4 there. [On a VPS with a domain](viewer.md#on-a-vps-with-a-domain) explains how it works; these are the steps. They have not been run end to end on a real VPS yet, so check each result and tell the user what you could not verify.

1. **The domain.** Ask the user for the name to use, such as `viewer.example.com`, and to point its DNS (an A record, and AAAA for IPv6) at the server. Check with `getent hosts viewer.example.com` that it resolves to the server's address (`curl -s https://ifconfig.me` shows it) before going on.
2. **The password.** The user picks it, at least 12 characters, and writes it themselves into an environment file that only they can read. Do not make it up, type it, repeat it in chat, or put it in a command, the shell history or any file in a repository. Create the file empty with the right permissions and let them fill it in:
   ```bash
   mkdir -p ~/.config/motlab && touch ~/.config/motlab/viewer.env && chmod 600 ~/.config/motlab/viewer.env
   ```
   It holds one line, `MOTLAB_VIEWER_PASSWORD=...`. Ask them to tell you when it is done.
3. **Caddy for HTTPS.** Check `caddy version`. If it is missing, ask before installing it and use the install steps on [caddyserver.com/docs/install](https://caddyserver.com/docs/install) for their distribution. Add the site block from the viewer doc to `/etc/caddy/Caddyfile`. If that file already has sites, add the block, do not replace the file, and show the user the change before reloading with `sudo systemctl reload caddy`.
4. **Ports.** 80 and 443 must be open for Caddy and its certificate. Do not open 4173: the viewer listens on `127.0.0.1` only and must stay behind Caddy. Ask before changing a firewall (`ufw`, a cloud provider's rules).
5. **Keep it running.** Ask which folder holds their video projects; the viewer's menu lists the projects in it. Then set up the systemd user service from [Keep it running](viewer.md#keep-it-running), with the domain and that folder filled in. A user service only runs while they are logged in unless lingering is on (`loginctl enable-linger`); ask before turning it on.
6. **Check it.** `curl -sI https://viewer.example.com/` must answer `302` with `location: /login`, and `systemctl --user status motlab-viewer` must be active. Then ask the user to open the address, sign in and press Export once, so a render on the server is known to work (`motlab doctor` must have found Chrome and ffmpeg there).
7. **Tell the user** the address, where the password file is, that changing the password means editing that file and running `systemctl --user restart motlab-viewer`, and that signing in again is needed after every restart.

Never run the viewer behind a public proxy without `--domain` (it would refuse saves and Export, and the wrong fix is to remove that check), never turn the login off, and never put the viewer's port on the internet directly. If the user has Tailscale and no domain, the viewer doc's Tailscale paragraph is the private alternative.

## Do not

- create video projects inside the clone, the npm package or the installed skill folder; a project lives in its own folder
- delete or overwrite a folder you did not create
- render a user's project unless they ask for it; the user exports from the viewer
