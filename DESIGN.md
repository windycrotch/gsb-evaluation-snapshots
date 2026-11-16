# Viewer design

This covers `src/editor.html`. The viewer is only for looking at a project and pointing at "this one" to talk about in chat, so it stays quiet and does not compete with the preview. The UI text is in Indonesian and English, from one table (`TEXT` at the top of the script). The examples here are the Indonesian text.

## Direction

- Dials: ENERGY 1, RHYTHM 1, MOTION 2.
- The style follows the Claude desktop app: its artboard for the grey canvas and floating pills, its header, and the plain lists of the Claude and ChatGPT sidebars. Parts of those apps that the viewer has no use for are not built. The reference screenshots are kept outside the repository.
- Short, direct text with no middle dots. For example, the selection box reads "Scene 2: 02-grafik", then "Detik 1.09, video 00:04.09".
- As few lines as possible. The header has one bottom line, half a pixel in `#ececeb`. The selection box at the bottom of the sidebar has none.

## Layout

- One header across both panes, after the Claude app header: the panel toggle on the left, `project / scene` in the middle (project name grey, current scene black), Export on the right. The project name and the version after it are buttons with a small chevron. Each opens a menu centred under it: projects with the folder name and its path in muted text, versions with the name and file name. The project menu ends with the other language, named in that language ("English" or "Bahasa Indonesia", with EN or ID in muted text), so someone who cannot read the current one still finds it. The open one has the selected-row grey. The version menu ends with "Versi baru dari ini", which turns into a name field and a small dark "Buat" button like Export.
- Two panes under the header, because the scene list and the preview need to be visible together. The grey canvas `#ececec` holds the preview, the play toolbar, the full-screen pill in the top right and the timeline card at the bottom.
- The play toolbar ends with two magnifier buttons that zoom the timeline, and a button that hides or shows the timeline (a frame with a bottom bar, like the panel icon with a side bar). Hidden, the preview fills the canvas up to the sidebar, and the zoom buttons are hidden too. It shows and hides at once, without a slide, and the browser remembers it. Zoomed in, the timeline scrolls sideways with a native scrollbar, and its canvas stays put (sticky) and draws only what is in view.
- The timeline is at most 35% of the window height and scrolls, so a project with many audio files does not push the preview out. The preview area is at least 150 px including padding.
- The timeline's final height is set as soon as `project.json` is read, so it does not jump when the scenes finish loading.
- Below 720 px the sidebar floats over the canvas instead of squeezing it, and it closes when the window becomes that narrow. On touch screens buttons grow to 44 px.
- Spacing is in steps of roughly 2 px (6, 8, 10, 12). Radius follows element size, from 3 px on the preview to 12 px on the timeline card.

## Colour

- White and neutral greys, so the colours in the scene preview are the only strong colours on screen.
- Blue `#2c6fe0` appears only on the timeline (the selected clip, the selection line, and a range as a 10% band with a 1 px edge on each side and an 8 by 14 px head at the top of each edge, like the playhead's), on the range button while it waits for a drag, on the bracket icon of the range bar, on the play button while the video is playing, and on the notes drawn on the preview. A note's box follows the selection box of the Claude canvas: a 1 px blue line, a light blue fill at 14% (22% for the open note), square corners. A point is a 16 px circle in the same style with a 5 px blue dot in the middle. Each has its number in a 16 px blue tag with white text above its top left corner (top right for a point). They sit over the preview as outline elements, so the line stays 1 px and sharp at any preview size. `selection/<n>.png` draws them the same, scaled to the frame. On the timeline the note numbers are tags in a row under the time labels: light blue `#dfe9fb` with blue text, solid blue with white text for the open note. A range note draws a 2 px line to the end of its range with a short end cap. All lines are drawn first and every tag over them with a 2 px margin in the colour behind it, so no line runs through a number.
- A range gets a second pill next to the play toolbar, in the same style: the bracket icon, "00:03.00", an arrow icon, "00:06.50" (the same everywhere a range is written, with "sampai" for screen readers), a thin divider and the length in muted text, a "Catatan" button and ×. The two wrap onto two rows when they do not fit. Below 480 px the toolbars drop the total length, the range length and the zoom buttons, so they fit a phone.
- The open note is a card like the menus (white, 12 px radius, the menu shadow) under its box, or above the timeline for a range note, with the number tag and where it is, a text field, a quiet "Hapus" and a small dark "Simpan" like Export. In the side panel the notes are rows like the audio rows, with the number in the grey tile; an empty note reads "Tanpa catatan" in muted text. The card's footer has a quiet "Tandai selesai" with a check icon between them ("Buka lagi" with a rotate icon on a done note, whose head then ends with a muted check and "Selesai"). Done notes fold under a muted "Selesai N" row with a chevron at the end of the list; unfolded, their number and text are muted and the text struck through. They are not drawn on the preview or the timeline unless one is open.
- Selected rows in the sidebar and in the Export menu use a grey background `#ebebea` and a bold name, like the active item in the Claude sidebar. No borders or accent bars. The Export button names the resolution it will export, so the menu needs no check mark. While an export runs, that button is disabled and faded like any disabled control, with a spinner and "Mengekspor 4K…". A full-width "Batalkan" button appears under it, tinted like the blue play button: red text `#b8322a` on `#fbe4e2` (4.90:1; hover `#f8d9d6`, 4.50:1). The resolution list cannot be changed meanwhile. Red is used for nothing else.
- Muted text `#666561` stays above 4.5:1 on every background it sits on (white, hover, selected row, canvas). The lowest is 4.78:1 on the selected row. The waveform `#85847f` is 3.31:1 against its clip, and the selected waveform in blue is 3.86:1.

## Tooltips

- Not the browser's `title`: a small dark label (`#1f1f1e`, white 12 px text, 8 px radius) after 0.5 s of hover, at once when moving between controls, and on keyboard focus. It sits above the control, or below it near the top of the window, and fades in with a 2 px move.
- Short names in the imperative, with the shortcut in a key cap next to it: "Tandai rentang [R]", "Putar [Spasi]". The explanation goes elsewhere: the range tool says what to do in the toast when it is picked.
- The timeline's tooltip is a two-column list of its keys (key caps left, what they do right in 70% white). It waits 1 s with the pointer still and goes away when the pointer moves on.

## Type

- Plus Jakarta Sans (400, 500, 600) from Google Fonts. The timeline canvas uses the same font and waits for it to load before drawing. Offline, the page falls back to the system font.
- Times use `tabular-nums` so they do not jitter during playback.

## Icons

- 1.5 px rounded strokes in a 16 px box, matching the references. Each icon shows its function directly: panel, export, full screen, play and pause, previous and next scene, waveform, zoom out and in, timeline, range, note, close, the arrow between a range's start and end, and a check and a rotate arrow for marking a note done and opening it again (Lucide's arrow-right, check and rotate-ccw, ISC, redrawn in the same box).

## Motion

- Motion only answers an interaction. The sidebar slides in 0.26 s when it opens or closes. The grid column is animated, so the list keeps its width and does not reflow; on narrow screens the floating sidebar slides with `transform`.
- The Export menu and the full-screen message fade in with a 4 px move over 0.14 s, using `@starting-style`. Hover and press colours change smoothly, and icon buttons shrink slightly when pressed.
- The cursor on the preview is a + (a drag there draws a box). It is dark `#1f1f1e` over light parts of the frame and white over dark parts, picked by the relative luminance of the frame under the pointer (below 0.179 white has the higher contrast). Each has a faint halo in the other colour for edges between light and dark. The brightness comes from a 64-cell-wide copy of the frame, read on the first pointer move after the frame changes, so playback costs nothing extra.
- The playhead is never animated, because it has to sit exactly on a frame. Nothing animates when the page first opens.
- All motion turns off under `prefers-reduced-motion`, including the export spinner.

## Accessibility

- Every scene and audio row is a button, so Tab, Enter and Space reach it. The timeline is a focusable slider.
- Icon buttons have `aria-label`, SVGs are `aria-hidden`, the play button's label switches to "Jeda" while playing, and the Export button has `aria-expanded`. The export status and the selection box are live regions.
- One `h1` (the project name in the header), plus `header` and `nav`.
- Empty and broken projects show a message that says what to do next.
