# The viewer

```bash
motlab edit <project>
```

This opens the project in the viewer at `http://127.0.0.1:4173/p/<folder>/`, prints the address and ends. When no viewer is running yet, it starts one first. The viewer is a server that runs in the background until it is stopped, and it only listens on `127.0.0.1`:

```bash
motlab start      # the viewer, without opening a project
motlab stop       # end it (an export that is running is cancelled)
motlab restart    # stop it and start it again from the same folder, for example after motlab update
```

`motlab start` prints the address; a second `start` says it is already running. The server's output goes to `~/.motlab/viewer.log`. `motlab start --foreground` runs the server in the terminal instead, until Ctrl+C.

One viewer holds many projects. The project name in the header is a menu of the motlab projects it knows: the folders with a `project.json` up to four levels under the folder `motlab edit` was started from (without `node_modules`, `out`, `backup` and hidden folders), and every project opened with `motlab edit` before, which is remembered in `~/.motlab/recent.json`. A project on another drive shows up in the menu after it has been opened once. The folder the menu scans is the one the viewer was started from, by `motlab start` or by the `motlab edit` that started it. `motlab edit` without a project prints the viewer's address, which opens the first project it finds. If port 4173 belongs to something else, the viewer takes the next free port up to 4190, and `motlab edit`, `stop` and `restart` find it there. The left panel lists the scenes and audio files, the middle shows the preview with the play controls, and the bottom has a timeline of scenes and audio with waveforms.

The viewer is for looking and pointing, not editing. While a page is open it watches the project folder, so a scene the agent saves shows without a reload ([Live updates](#live-updates)).

## Language

The viewer's text is in English or Indonesian. It follows the browser: Indonesian when one of the browser's languages is Indonesian, English otherwise. The last row of the project menu switches to the other language ("Bahasa Indonesia" or "English") and reloads the page, and the browser remembers the choice. This page names the controls in English. In Indonesian, Notes and Note are Catatan, Save is Simpan, Delete is Hapus, Mark done is Tandai selesai, Reopen is Buka lagi, Done is Selesai, Open is Buka, Cancel is Batalkan, "New version from this one" is "Versi baru dari ini" and Main is Utama.

## Versions

The name after the project in the header is the version menu. It lists every project file in the folder (see [Versions](projects.md#versions)), with `project.json` as "Main". "New version from this one" asks for a name and copies the open version to `project-<name>.json`, then opens it; the agent changes what is in it. The open version is in the address as `?v=project-tiktok.json`, and Export renders that version to `out/<folder>-<version>-<resolution>.mp4`. `selection.json` names the version a click was made in as `project`.

## Keys and controls

| Action | How |
|---|---|
| Play and pause | Space (on a focused button, Space presses that button instead) |
| Step one frame, one second | Left and Right arrows on the focused timeline, with Shift for one second |
| Jump to start or end | Home and End on the focused timeline |
| Previous or next scene | the buttons next to play |
| Zoom the timeline | Ctrl+scroll or a trackpad pinch, the magnifier buttons, or `+`, `-` and `0` on the focused timeline |
| Scroll a zoomed timeline | its scrollbar, Shift+scroll, or plain scroll when there is no vertical scroll |
| Mark a range | the range button in the play toolbar (or `R`), then drag on the timeline; or Shift+drag on the timeline; or `I` and `O` at the playhead for its start and end; drag an edge or its blue head to change it |
| Make the scene a range | `X`, for the scene under the playhead |
| Remove the range | the × in the range bar, or Escape when no note is open and the pencil is not picked |
| A note with a box | drag on the preview, then type |
| A note on one spot | click on the preview without dragging, then type |
| Pick the pencil | the pencil button in the note tools next to the play toolbar, or `P`; the box button, `M` or Escape goes back to boxes and points |
| A note drawn with the pencil | with the pencil picked, draw on the preview, then type; more strokes go into the same note until it is closed |
| Take back the last stroke | the undo arrow in the open pencil note, or Ctrl+Z (Cmd+Z on a Mac); Shift+Ctrl+Z or Ctrl+Y puts it back |
| A note on a range | mark the range, then Note in the range bar |
| Save and close a note | Enter, Save, Escape, or a click on the empty grey space around the preview (Shift+Enter is a new line) |
| Open a note | its row under Notes, its number on the timeline, or a click on its box |
| Move or resize a note's box | open the note, then drag inside its box to move it, or a corner or an edge to resize it; a point and a drawing move the same way, with boxes and points picked |
| Delete a note | Delete in the open note |
| Mark a note done | Mark done in the open note; Reopen opens it again |
| See the done notes | Done at the end of the Notes list |
| Delete all done notes | Delete all done notes, under the unfolded done notes, then click it again within 4 s |
| Hide the timeline | the last button in the play toolbar |
| Hide the side panel | the button in the top left |
| Full screen | the button in the top right of the preview, or `F`; Escape, `F` or the button on the right of the player bar to leave |

Every button in the toolbars has a tooltip with its shortcut, and resting the pointer on the timeline for a second lists the timeline's keys.

The timeline zooms up to 24 px per frame, and close in the ruler gets a tick per frame. While it plays zoomed in, the view follows the playhead. Hiding the timeline gives the preview the whole canvas, up to the side panel, or the full width with the panel closed. The browser remembers that choice and the last export resolution.

Over the preview the cursor is a +. It is dark over light parts of the frame and white over dark ones.

## selection.json

Every click on a scene, an audio clip or a point on the timeline is saved to `selection.json` in the project folder, so you can tell an agent "this one" in chat. The range and every note are saved with it:

```json
{
  "project": "project.json",
  "time": 0.947,
  "scene": "scenes/01-judul.html",
  "sceneIndex": 1,
  "sceneTime": 0.947,
  "frame": 28,
  "transition": null,
  "audio": null,
  "range": { "start": 2.2, "end": 6.133, "scenes": [1, 2] },
  "marks": [
    {
      "n": 1,
      "note": "Batang ketiga harusnya lebih tinggi",
      "time": 6.42, "scene": "scenes/02-grafik.html", "sceneIndex": 2, "sceneTime": 3.42, "frame": 102, "transition": null,
      "box": { "x": 531, "y": 577, "w": 964, "h": 437 },
      "point": null,
      "range": null,
      "image": "selection/1.png",
      "project": "project.json"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `project` | the project file in use, so a click in one cut is not taken for another |
| `time` | seconds from the start of the video, where the click landed |
| `scene`, `sceneIndex` | the scene page and its number, from 1 |
| `sceneTime` | seconds into that scene |
| `frame` | the frame of that scene the preview shows; `frame / fps` is its time on the render's frame grid |
| `transition` | inside a transition: `{ type, from, frame, frames }`, the scene number it comes from and its frame `frame` of `frames`; else `null`. `scene` is then the scene it leads into. Inside a layer over a cut it is `{ layer, from, frame, frames }`, and `scene` is the one under the layer |
| `audio` | `{ file, start, index }` when the click was on an audio clip, else `null` |
| `range` | `{ start, end, scenes }` when a range is marked, else `null`: seconds from the start of the video, on the frame grid, and the scene numbers it covers |
| `marks` | the notes, see below |

Each note in `marks` has its number `n`, an `id` the page gives it (notes from before ids have none), the text `note`, where it was made (the same fields as a click), and one of:

| Field | Meaning |
|---|---|
| `box` | `{ x, y, w, h }` in the scene's own pixels at `?scale=1`, the units the scene code uses |
| `point` | `{ x, y }` in the same units |
| `stroke` | a drawing made with the pencil: a list of strokes, each a list of `[x, y]` points in the same units; `box` is then the box around it |
| `range` | `{ start, end, scenes }`, as above |

`image` is `selection/<n>.png` for a box, a point or a drawing: that frame with the note's box, point or strokes and its number drawn on it, as on screen. `project` is the version the note was made in. `done: true` marks a note as done; an open note has no `done`.

A range marks a stretch of time, for a note such as "seconds 3 to 5 are too slow". The range button in the play toolbar turns blue and the page says to drag on the timeline; the drag marks the range and the button turns off again, so the next drag scrubs as usual. The range is a light blue band over the whole timeline with a blue head at the top of each edge, like the playhead's, to drag it by, and a range bar appears next to the play toolbar with its start, end and length, Note to write a note about it, and × to remove it. While there is a range, Play starts at its start and goes round inside it; a click elsewhere while playing plays on from there. A click on the timeline moves the playhead and keeps the range.

## Notes

A note says what is wrong at one spot, so a whole review can be written down while watching and handed to the agent at once ("kerjakan semua catatan"). Drag a box over the part, or click one spot, and a card opens under it to type in. A box or point belongs to the frame it was drawn on and shows only on that frame, with its number in a small blue tag. Several notes can sit on one frame. A note on a range is about a stretch of time instead.

Notes stay until they are deleted. They are numbered in the order they were made and listed under Notes in the side panel, and their numbers sit in a row on the timeline under the time labels; a range note draws a line to the end of its range. A click on either goes to the note's frame (and its range) and opens it. A click on the preview while a note is open only closes it, so a stray click does not make a new note.

A note that has been dealt with can be marked done, by the user with Mark done in the open note or by the agent with `"done": true` in `selection.json`. A done note leaves the preview and the timeline and moves under Done at the end of the list, folded, so the list holds what is left for the next round. The number next to Notes counts the open notes only. A done note opened from the list shows on its frame again, says Done in its head, and Reopen makes it an open note again when the fix was not right.

The agent writes `done` into the file while the page is open. So the viewer keeps the file's `done` for every note it did not change itself, and the server sends back which notes are done after each save. The page also reads the file again when it gets focus back, so a note the agent marked done moves under Done without a reload. A note the agent deletes from the file is gone from the page then too.

An open note's box has a small square on each corner. Dragging inside the box moves it, and dragging a corner or an edge resizes it; the cursor shows which. An open point can be dragged too. The box stays inside the frame, keeps its number, text and frame, and its picture in `selection/` is drawn again. A drag on the preview with no note open still draws a new box, even over an old one, so a box has to be opened before it can be moved.

The pencil draws freehand, for circling something or drawing an arrow at it. Pick it with `P` or the pencil button in the note tools, a small toolbar next to the play toolbar, and the cursor becomes a dot. A stroke on the preview makes a note as a box does, and its card opens. More strokes go into the same note until the note is closed, so a circle and an arrow are one note. The undo arrow in the card's head, or Ctrl+Z, takes back the last stroke down to the first one (Delete removes the note), and Shift+Ctrl+Z or Ctrl+Y puts it back until a new stroke is drawn. In the card's text field, Ctrl+Z takes back a stroke only while the text has not changed since that stroke; after typing, it undoes the typing. A click with the pencil marks nothing, and a click on a note opens it. `M`, Escape or the box button goes back to boxes and points, and with those a drawing moves like a box: open the note and drag inside its outline. It is not resized. The strokes are blue with a light halo, so they show on light, dark and blue frames, and they are kept in `stroke` with the fewest points that stay within 0.75 screen pixels of what was drawn: a circle drawn with 127 pointer events kept 27 points. `box` is the box around them, so an agent that reads boxes still knows where the drawing is.

The done notes can be deleted in one go with Delete all done notes, the last row under the unfolded done notes. The first click turns the row into "Click again to delete 2 notes" for 4 seconds, and a second click deletes them and their pictures, as Delete does one by one. It deletes the done notes of the open version only.

Full screen shows the preview on the whole screen with a player bar along its bottom edge. The bar has a scrub bar across its width, split into the scenes and dark up to the playhead: click or drag it to move in time, and rest the pointer on it to see the time there. The open notes' numbers sit above it, and a click on one opens that note; a range shows as a light blue band. Under it, the time and the scene's name are on the left, previous, play and next in the middle of the screen, and a button on the right leaves full screen. The Left and Right arrows step one frame anywhere in full screen (one second with Shift), and Home and End jump to the start and the end. The timeline, the range bar and the range, zoom and timeline buttons stay out of full screen; `R` does nothing there, while `I`, `O` and `X` still mark a range at the playhead. The bar stays hidden so that it covers nothing, also while the video is paused, and comes up like an auto-hidden taskbar while the pointer is in the bottom 120 px of the screen. It also shows for 2.5 seconds on entering full screen and after Space, the arrows, Home or End. Drawing or moving a note never brings it up, so a box can be drawn down to the bottom of the frame. While the video plays and the pointer rests for 2.5 seconds with the bar hidden, the cursor hides too.

On a touch screen, where no pointer rests near the bottom, the hidden bar leaves a short white line at the bottom edge, like a phone's home bar, and a tap on it brings the bar up for 2.5 seconds. So does a tap anywhere in the bottom 120 px of the screen, instead of marking a point there, and a drag from that strip still draws a box. On an iPhone, Safari only lets a video element go full screen, so the full-screen button says that full screen is not available there.

Notes work in full screen too: the card opens over the full-screen preview and takes typing, and Save writes the note. On a touch screen a finger drag draws a box like the mouse does, and a tap on Save saves it (tried in a windowed Chrome over the DevTools protocol, with touch emulated).

Two tabs on the same project can both take notes. A save names the notes the tab deleted instead of leaving them out, so notes made in the other tab are kept, and a new note whose number the other tab took first moves to the next free number, with its picture drawn again. After every save, and when a tab gets focus back, the page takes in the file's notes: the other tab's new ones, the ones it deleted, and done marks. Tried in a windowed Chrome over the DevTools protocol with two tabs: tab B's first note became 2 next to tab A's 1, each tab listed the other's notes after a focus change, a note deleted in B stayed deleted when A saved again, and every picture showed its own number. Two tabs editing the text of the same note still keep whichever saved last.

Each version has its own notes. The numbers run across all versions of the folder, so "catatan 3" means one note. The selection is written about 0.15 s after the last change, so scrubbing and typing do not write a file per pointer move or key. The last selection and the notes are loaded again when the page opens.

`selection.json`, `selection.png` (from before notes) and `selection/` are in `.gitignore`.

## Live updates

While a page is open, the server watches the project folder and sends every saved file to the page over one event stream (`/p/<project>/__events`). Renders in `out/`, `backup/`, the note pictures in `selection/`, `node_modules` and hidden or temporary files are left out. The page knows which files each scene's page loaded, from the browser's resource timing, so a save loads again only the scenes that use the file: a scene's own HTML loads that scene, and a `lib.js` three scenes share loads all three. The new page loads in the background and its length and thumbnails are read again; only then does it take the old page's place, at the frame on screen. Meanwhile the scene's row says "loading again" after its number and its tile on the timeline has a "Loading" tag; the preview keeps the old frame until the new page is in. When it is in, a message says "Scene 2 updated". A scene that changed length moves the scenes after it.

A page that does not load keeps the old one loaded: a syntax error while the agent is still writing, no `<canvas id="c">`, no `renderAt` and `TOTAL`, or `ready` not resolving within 20 s. The scene's row and tile then say Error, and the preview shows a blank pane with the alert icon and the reason in place of that scene. When the scene is not on screen, a message says so instead. While the agent says it is working on the scene, its pane wins, since a scene that breaks for a moment mid-edit is expected. The next save that works clears it. A scene that is already broken when the page opens is kept the same way, as a 2 s scene with a blank thumbnail, so the rest of the project opens; the save that fixes it loads it with its real length. Only when no scene loads does the page say so instead of opening.

A file the viewer page loaded itself, such as the project file, its audio or a transition's `.glsl` or layer module, loads the whole page again, and the selection brings back the time. While a note is open or the Export menu is open, it waits and says so, and reloads once they are closed. `selection.json` is read again at once, so a note the agent marks done moves under Done straight away.

`motlab working <project> [text] --note 3,5 --scene 2` tells the open pages what the agent is working on. The scenes it names, and the scenes of the notes it names, are not shown while it works, paused or playing: a blank pane takes the frame's place, with a small loader (scene tiles filling as a playhead sweeps across them) and "The agent is working". The pane covers that frame's notes, and no note can be drawn on it. The audio plays on. The scene list says "fixing" after the scene number, the timeline tile has a "Fixing" tag, and the notes start their second line with "In progress:". The agent's own words are read to a screen reader. `motlab working <project> --done` brings the scene back, and so does 10 minutes with no word from the agent and no saved file. A page opened later gets the current work at once. With no viewer running, or no page open on that project, the command says nobody sees it and still succeeds, so an agent can always call it.

Tried in Chrome on the Windows laptop with a copy of `example/`: a change to `02-grafik.html` loaded scene 2 again and nothing else, a change to the shared `lib.js` loaded all three scenes, a syntax error in scene 2 showed the reason in its place and the fix brought the new page in, `motlab working . --scene 2` replaced the scene with the work pane on a 375 px phone, an 800 px window and at 1280 px, and `--done` brought it back. `test/live.test.js` checks that a saved file reaches the page and the viewer's own pictures do not. Not tried: the event stream through Caddy on a real VPS, and a project folder on a network drive, where file watching may not report changes.

## On a phone

Held upright, the viewer fits the screen and does not scroll, so the preview stays in view: the preview across the top, the play toolbar under it across the width with the full-screen button at its end, the note tools under that as two labelled halves (box or point, and pencil), and the timeline. Four tabs along the bottom, Catatan (Notes, with the number of open notes), Scene, Audio and Seleksi (Selection), open that list in a sheet over the toolbars and the timeline. A tap on a scene, an audio file or a note in the sheet goes there and closes it, and so do a tap on the open tab, on the dimmed area or Escape. The header shows the project and its version; the scene's name is on the timeline, and Export is its icon. The project, version and Export menus open across the width under the header. The open note's card sits across the bottom of the screen above the tabs, above the keyboard while it types, and short messages are a bar above the tabs, above the card when one is open.

On the timeline a finger that moves sideways drags the playhead, or a range in range mode, and one that moves up or down scrolls the timeline's rows. Held sideways, the viewer keeps its two panes, with the side panel closed at first and floating over the preview when it opens.

Checked in headless Chrome over the DevTools protocol with a phone emulated (touch, 2x pixels) at 390x844 and 360x740 upright and 844x390 and 740x360 sideways: no sideways scrolling, every menu inside the screen, and a box drawn with touch events opened its card inside the screen and saved the note. The tabs and their sheet were checked in Chrome at 375x812 and 360x640 with a phone emulated: the page is as high as the screen, each tab opens its list, a scene picked in the sheet moves the playhead there and closes it, and a note's card sits above the tabs. On a real Android phone over Tailscale the viewer opened, and the pencil drew with a finger. Dragging on the timeline with a finger and the line that brings the full-screen bar back have not been tried on a real phone since they changed: the browser pane used for the check has no full screen.

## Export

The Export button in the top right renders the project. Pick 720p, 1080p, 1440p or 4K and press the button under the list, which names the size it will make. The viewer's server runs the same render as `motlab render` and streams the log back to the page; the log also appears in the terminal. The file is written to `out/<folder>-<resolution>.mp4` in the project folder, for example `example/out/example-1080p.mp4`, or `out/<folder>-<version>-<resolution>.mp4` for another version, and the Open link opens it. The resolution in the name is the short side of the frame: 4K is written as `-2160p`. Only one export runs at a time. Export uses `qp` and `codec` from the project file when it has them ([File size](rendering.md#file-size)).

Under the sizes, "Scene yang dirender bersamaan" (Scenes rendered at once) sets how many scenes and transitions render at the same time, as `--parallel` does for `motlab render` ([Rendering a project](projects.md#rendering-a-project)). Otomatis (Auto) leaves it to the server, which picks 3, or fewer on a machine with fewer than 12 CPU threads or less than 3 GB of free memory; the line under it says the number. The server is the machine that renders, so on a VPS the number is the VPS's, even when the viewer is open on a phone. It asks again each time the menu opens, as free memory changes. 1 renders one scene at a time and leaves the computer free for other work. A number above Auto's turns the line red: it may be slower, or fail when memory runs out, and then the render goes on one scene at a time. The pick is remembered in this browser. On the example project (3 scenes, 720p, on the 16-thread Windows test laptop) Auto rendered 2 at a time, as a project with 3 scenes has 2 left after the first, and took 14 s; 1 took 20 s.

While an export runs, the button is faded with a spinner and a red Cancel button appears under it. Pressing Cancel stops the render: the server closes its headless Chrome and any ffmpeg step, deletes the temp files, and the menu shows "Export cancelled". The file that was being written is never left half done in `out/`, because the render writes it as `.part` and renames it only when it is complete; an earlier export of the same size stays as it was. On the example project at 4K a cancel took 0.3 s. Reloading the page does not cancel an export; it keeps running in the terminal, and Export answers that another export is still running until it ends.

## On a VPS with a domain

The viewer can run on a server and be opened from anywhere at a domain of your own, behind a password. It still listens only on `127.0.0.1`; a reverse proxy on the same server gives it HTTPS and passes requests to it. With [Caddy](https://caddyserver.com), which gets the certificate by itself, the whole proxy is a Caddyfile:

```text
viewer.example.com {
    reverse_proxy 127.0.0.1:4173
}
```

Point the domain's DNS at the server, then start the viewer with the domain and a password of at least 12 characters in `MOTLAB_VIEWER_PASSWORD`:

```bash
MOTLAB_VIEWER_PASSWORD='a long password of your own' motlab start --domain viewer.example.com
```

Open `https://viewer.example.com` and sign in. Then:

- Every request needs the login, whatever address it comes in on, so a proxy that rewrites the Host header to `127.0.0.1` does not skip it. Only the sign-in page answers without it.
- The session is a cookie that is HttpOnly, Secure and SameSite=Strict, and lasts 30 days or until the viewer stops. A save, a new version or an Export must come from the viewer's own page on `https://viewer.example.com`; a request from another site is refused.
- After 5 wrong passwords in a minute, the login waits until the minute is over.
- `motlab edit`, `stop` and `restart` on the server still work: the viewer writes a random token to `~/.motlab/viewer-token` (readable only by you on Linux and macOS) and removes it when it stops, and the commands send it. `restart` keeps the domain.
- Export renders on the server, so the server needs Chrome and ffmpeg (`motlab doctor`). The finished file opens from the Open link as it does on your own machine.

The password is read from the environment so that it does not show up in the process list. Put it in your service manager's environment file rather than in a command line that the shell history keeps. A proxy other than Caddy works the same way: HTTPS in front, `127.0.0.1:4173` behind it.

### Keep it running

On a Linux server, a systemd user service starts the viewer again after a reboot or a crash. Put the password in `~/.config/motlab/viewer.env` as one line, `MOTLAB_VIEWER_PASSWORD=...`, readable only by you (`chmod 600`), and this in `~/.config/systemd/user/motlab-viewer.service`, with your domain, your projects folder and the path that `command -v motlab` prints:

```ini
[Unit]
Description=motlab viewer

[Service]
EnvironmentFile=%h/.config/motlab/viewer.env
WorkingDirectory=%h/videos
ExecStart=/usr/local/bin/motlab start --foreground --domain viewer.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now motlab-viewer
loginctl enable-linger "$USER"
```

The last line keeps it running when you are not logged in. `systemctl --user restart motlab-viewer` picks up a new password; everyone signs in again after a restart. This unit has not been run on a real server yet.

Without a domain of your own, [Tailscale](https://tailscale.com) keeps the viewer private to your own devices: `tailscale serve 4173` on the server gives it an HTTPS name on your tailnet. Start the viewer with `--domain` set to that name and a password, because without `--domain` the viewer refuses saves and Export from any name but `127.0.0.1`. `tailscale serve` passes that name on as the Host header, which is what the viewer checks. If a phone on the tailnet says the site cannot be reached while a laptop opens it, the phone is not resolving `.ts.net` names: turn off Android's Private DNS and the browser's own secure DNS, and check that the Tailscale app uses Tailscale DNS. This setup has opened the viewer from a laptop and a phone.

Tested on the Windows laptop: `test/access.test.js` checks the login, the cookie, refused writes from other sites and other Host headers, the token, the wait after wrong passwords and signing out. The real viewer was started with `--domain` and checked with curl sending the domain's Host header as a proxy does, and in Chrome on `localhost`: the sign-in page came first, a wrong password was refused, the right one opened the project, and a click saved `selection.json`. `motlab edit` and `motlab stop` worked through the token, and the token file was gone after the stop. Not tried yet: a real VPS behind Caddy with a real certificate, and Tailscale Serve.

## How the preview works

Nothing is rendered to a file for the preview. Each scene is its real page in a hidden iframe at `?scale=1`, and the preview copies its canvas, so you see exactly what the render draws, on the same frame grid.

When the viewer opens, it goes through the scenes one at a time for their length and a few thumbnails (one per 2 seconds, at most 12 per scene). After that only three scene pages stay loaded: the one on screen and its neighbours. The next scene is loaded ahead while playing, and its first frame is drawn once, so footage in it has already sought to its start when playback reaches the cut. A test project with 45 scenes (2:15) opened in about 4 seconds. A project of 20 WebGL scenes (ten three.js scenes with a rigged GLB, ten p5.js WebGL scenes) and a 60-minute AAC file opened, played across scene cuts and jumped to scene 19 without a lost WebGL context, since no more than three pages are loaded at once. Audio plays through WebAudio, and the audio clock drives the playhead, so picture and sound cannot drift apart.

What the viewer plays was recorded off its audio graph on the example project and compared with the render of the same project: the same events at the same times, the same loudness (-19.9 LUFS integrated, -7.2 dBTP) and level within 0.02 dB, with no dropouts or clipping (measured, and listened to with earshot).

Scene transitions from `project.json` play in the preview: in the overlap the viewer draws both scenes and mixes them with `src/page/transitions.js`, the code the render uses. On the timeline the two tiles overlap, and the overlap is lighter with a bowtie on it. A layer over a cut is drawn over the preview by its own module, and on the timeline the tiles meet at the cut with the bowtie on it and a lighter band over the frames the layer covers. A transition frame in the viewer and in the 1080p MP4 differed by 1.37 levels of 255 on average (example project, desktop app's browser). A wrong transition type, or one too long for its scenes, shows a message instead of the project.

A frame is drawn only when the playhead reaches a new one. The display refreshes many times per video frame, and drawing the same frame again took time from the next one.

Measured on a 16-scene, 30 fps, 1080x1920 talking-head project with 1440x1440 footage, in the desktop app's browser on the AMD integrated GPU of the test laptop:

| | Before | After |
|---|---|---|
| `renderAt` calls per second while playing | about 213 (one per display refresh) | 29 to 30 |
| First frame after a cut into a footage scene | 161 to 221 ms | 10 to 17 ms |

One frame of those scenes took 4.7 to 6.6 ms to draw, and the same at `?scale=0.5`, so a lower preview resolution would not help them. Not yet measured in a normal Chrome window at 60 or 144 Hz.

The page loads Plus Jakarta Sans from Google Fonts and falls back to the system font offline. Its visual design is described in [DESIGN.md](../DESIGN.md).
