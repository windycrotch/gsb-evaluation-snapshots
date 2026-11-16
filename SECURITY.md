# Security policy

## Scope

motlab runs local code: headless Chrome, ffmpeg and small HTTP servers on `127.0.0.1`. Scene pages are trusted code, like any script you run, so a page that does something harmful is not a motlab vulnerability. These are:

- a way for a project file (`project.json`, a scene path, an audio entry) to run commands or write files outside the project folder
- path traversal in the render server or the viewer server, reading files outside the served folder
- command injection through a file name or option passed to ffmpeg, ffprobe or Chrome
- a server that listens on anything other than `127.0.0.1`, or accepts requests from other sites in a way that writes files
- the installer deleting or overwriting files outside the paths it prints

Out of scope: bugs in Chrome or ffmpeg themselves, and someone who already has a shell on the machine.

## Reporting

Report privately through GitHub Security Advisories:

<https://github.com/staryone/motlab/security/advisories/new>

Please do not open a public issue for a vulnerability. Include the version or commit, the command that triggers it, and the smallest project that reproduces it. You will get an answer within a week, and a fix and disclosure date will be agreed with you before anything is published.

## Supported versions

Only the latest commit on `main` is supported.

## What motlab never asks for

motlab needs no account, password, token or API key. If an issue or pull request asks you for one, treat it as hostile.
