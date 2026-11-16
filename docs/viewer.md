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

The viewer is for looking and pointing, not editing. It does not watch files, so reload the page after the project changes.

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
| Remove the range | the × in the range bar, or Escape when no note is open |
| A note with a box | drag on the preview, then type |
| A note on one spot | click on the preview without dragging, then type |
| A note on a range | mark the range, then Note in the range bar |
| Save and close a note | Enter, Save, Escape, or a click on the empty grey space around the preview (Shift+Enter is a new line) |
| Open a note | its row under Notes, its number on the timeline, or a click on its box |
| Delete a note | Delete in the open note |
| Mark a note done | Mark done in the open note; Reopen opens it again |
| See the done notes | Done at the end of the Notes list |
| Hide the timeline | the last button in the play toolbar |
| Hide the side panel | the button in the top left |
| Full screen | the button in the top right of the preview |

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
| `transition` | inside a transition: `{ type, from, frame, frames }`, the scene number it comes from and its frame `frame` of `frames`; else `null`. `scene` is then the scene it leads into |
| `audio` | `{ file, start, index }` when the click was on an audio clip, else `null` |
| `range` | `{ start, end, scenes }` when a range is marked, else `null`: seconds from the start of the video, on the frame grid, and the scene numbers it covers |
| `marks` | the notes, see below |

Each note in `marks` has its number `n`, an `id` the page gives it (notes from before ids have none), the text `note`, where it was made (the same fields as a click), and one of:

| Field | Meaning |
|---|---|
| `box` | `{ x, y, w, h }` in the scene's own pixels at `?scale=1`, the units the scene code uses |
| `point` | `{ x, y }` in the same units |
| `range` | `{ start, end, scenes }`, as above |

`image` is `selection/<n>.png` for a box or point: that frame with the note's box or point and number drawn on it, as on screen. `project` is the version the note was made in. `done: true` marks a note as done; an open note has no `done`.

A range marks a stretch of time, for a note such as "seconds 3 to 5 are too slow". The range button in the play toolbar turns blue and the page says to drag on the timeline; the drag marks the range and the button turns off again, so the next drag scrubs as usual. The range is a light blue band over the whole timeline with a blue head at the top of each edge, like the playhead's, to drag it by, and a range bar appears next to the play toolbar with its start, end and length, Note to write a note about it, and × to remove it. While there is a range, Play starts at its start and goes round inside it; a click elsewhere while playing plays on from there. A click on the timeline moves the playhead and keeps the range.

## Notes

A note says what is wrong at one spot, so a whole review can be written down while watching and handed to the agent at once ("kerjakan semua catatan"). Drag a box over the part, or click one spot, and a card opens under it to type in. A box or point belongs to the frame it was drawn on and shows only on that frame, with its number in a small blue tag. Several notes can sit on one frame. A note on a range is about a stretch of time instead.

Notes stay until they are deleted. They are numbered in the order they were made and listed under Notes in the side panel, and their numbers sit in a row on the timeline under the time labels; a range note draws a line to the end of its range. A click on either goes to the note's frame (and its range) and opens it. A click on the preview while a note is open only closes it, so a stray click does not make a new note.

A note that has been dealt with can be marked done, by the user with Mark done in the open note or by the agent with `"done": true` in `selection.json`. A done note leaves the preview and the timeline and moves under Done at the end of the list, folded, so the list holds what is left for the next round. The number next to Notes counts the open notes only. A done note opened from the list shows on its frame again, says Done in its head, and Reopen makes it an open note again when the fix was not right.

The agent writes `done` into the file while the page is open. So the viewer keeps the file's `done` for every note it did not change itself, and the server sends back which notes are done after each save. The page also reads the file again when it gets focus back, so a note the agent marked done moves under Done without a reload. A note the agent deletes from the file is gone from the page then too.

Notes work in full screen too: the card opens over the full-screen preview and takes typing, and Save writes the note. On a touch screen a finger drag draws a box like the mouse does, and a tap on Save saves it (tried in a windowed Chrome over the DevTools protocol, with touch emulated).

Two tabs on the same project can both take notes. A save names the notes the tab deleted instead of leaving them out, so notes made in the other tab are kept, and a new note whose number the other tab took first moves to the next free number, with its picture drawn again. After every save, and when a tab gets focus back, the page takes in the file's notes: the other tab's new ones, the ones it deleted, and done marks. Tried in a windowed Chrome over the DevTools protocol with two tabs: tab B's first note became 2 next to tab A's 1, each tab listed the other's notes after a focus change, a note deleted in B stayed deleted when A saved again, and every picture showed its own number. Two tabs editing the text of the same note still keep whichever saved last.

Each version has its own notes. The numbers run across all versions of the folder, so "catatan 3" means one note. The selection is written about 0.15 s after the last change, so scrubbing and typing do not write a file per pointer move or key. The last selection and the notes are loaded again when the page opens.

`selection.json`, `selection.png` (from before notes) and `selection/` are in `.gitignore`.

## Export

The Export button in the top right renders the project. Pick 720p, 1080p, 1440p or 4K and press the button under the list, which names the size it will make. The viewer's server runs the same render as `motlab render` and streams the log back to the page; the log also appears in the terminal. The file is written to `out/<folder>-<resolution>.mp4` in the project folder, for example `example/out/example-1080p.mp4`, or `out/<folder>-<version>-<resolution>.mp4` for another version, and the Open link opens it. The resolution in the name is the short side of the frame: 4K is written as `-2160p`. Only one export runs at a time.

While an export runs, the button is faded with a spinner and a red Cancel button appears under it. Pressing Cancel stops the render: the server closes its headless Chrome and any ffmpeg step, deletes the temp files, and the menu shows "Export cancelled". The file that was being written is never left half done in `out/`, because the render writes it as `.part` and renames it only when it is complete; an earlier export of the same size stays as it was. On the example project at 4K a cancel took 0.3 s. Reloading the page does not cancel an export; it keeps running in the terminal, and Export answers that another export is still running until it ends.

## How the preview works

Nothing is rendered to a file for the preview. Each scene is its real page in a hidden iframe at `?scale=1`, and the preview copies its canvas, so you see exactly what the render draws, on the same frame grid.

When the viewer opens, it goes through the scenes one at a time for their length and a few thumbnails (one per 2 seconds, at most 12 per scene). After that only three scene pages stay loaded: the one on screen and its neighbours. The next scene is loaded ahead while playing, and its first frame is drawn once, so footage in it has already sought to its start when playback reaches the cut. A test project with 45 scenes (2:15) opened in about 4 seconds. A project of 20 WebGL scenes (ten three.js scenes with a rigged GLB, ten p5.js WebGL scenes) and a 60-minute AAC file opened, played across scene cuts and jumped to scene 19 without a lost WebGL context, since no more than three pages are loaded at once. Audio plays through WebAudio, and the audio clock drives the playhead, so picture and sound cannot drift apart.

What the viewer plays was recorded off its audio graph on the example project and compared with the render of the same project: the same events at the same times, the same loudness (-19.9 LUFS integrated, -7.2 dBTP) and level within 0.02 dB, with no dropouts or clipping (measured, and listened to with earshot).

Scene transitions from `project.json` play in the preview: in the overlap the viewer draws both scenes and mixes them with `src/page/transitions.js`, the code the render uses. On the timeline the two tiles overlap, and the overlap is lighter with a bowtie on it. A transition frame in the viewer and in the 1080p MP4 differed by 1.37 levels of 255 on average (example project, desktop app's browser). A wrong transition type, or one too long for its scenes, shows a message instead of the project.

A frame is drawn only when the playhead reaches a new one. The display refreshes many times per video frame, and drawing the same frame again took time from the next one.

Measured on a 16-scene, 30 fps, 1080x1920 talking-head project with 1440x1440 footage, in the desktop app's browser on the AMD integrated GPU of the test laptop:

| | Before | After |
|---|---|---|
| `renderAt` calls per second while playing | about 213 (one per display refresh) | 29 to 30 |
| First frame after a cut into a footage scene | 161 to 221 ms | 10 to 17 ms |

One frame of those scenes took 4.7 to 6.6 ms to draw, and the same at `?scale=0.5`, so a lower preview resolution would not help them. Not yet measured in a normal Chrome window at 60 or 144 Hz.

The page loads Plus Jakarta Sans from Google Fonts and falls back to the system font offline. Its visual design is described in [DESIGN.md](../DESIGN.md).
