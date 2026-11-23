# Projects

A project is a folder with scene pages, audio files and a `project.json`:

```json
{
  "fps": 30,
  "scenes": ["scenes/01-judul.html", "scenes/02-grafik.html"],
  "audio": [
    { "file": "audio/musik.wav", "start": 0, "volume": 0.6 },
    { "file": "audio/whoosh.wav", "start": 2.2, "volume": 0.8 }
  ]
}
```

- Scenes play in list order, and each lasts as long as its page's `TOTAL`, rounded to the frame grid.
- A scene can be an object with a `transition` from the scene before it (see [Transitions](#transitions)). A plain path is a hard cut.
- All scenes must have the same canvas size, and the render stops with an error that names the scene that differs. That size sets the orientation: landscape, portrait and square all work.
- `start` is seconds from the start of the video, and `volume` is a multiplier (1 leaves it as is).
- A mono file plays at the same level on both channels, in the viewer and in the render.
- An audio entry can also be a video file, whose sound is used. Any entry can take `from` (seconds into the file) and `duration` to use only part of it.
- Audio that runs past the end of the video is cut.
- `qp` and `codec` trade file size against quality, for `motlab render` and the viewer's Export alike: `"qp": 22` makes a file about 30% smaller than the default 18 at nearly the same quality, and `"codec": "hevc"` asks for HEVC. `--qp` and `--codec` on `motlab render` override them. The measurements are in [File size](rendering.md#file-size).

Paths are relative to the folder that holds the project file. [`example/`](../example) is a sample with three scenes, music and three sound effects, all generated with ffmpeg (`sine` and `anoisesrc`).

## Versions

A folder can hold more than one cut of the same video: every `.json` file in it with a `scenes` list is a version, for example `project-tiktok.json` next to `project.json`. One video often goes to several places, and one place keeps a part (an affiliate link, say) that another wants removed. Each version lists its own scenes and audio and shares the folder's assets, so a version that drops a scene just leaves it out. A version that needs a different scene gets its own copy, such as `scenes/05-cta-tiktok.html`, listed only in that version.

In the viewer the second name in the header is the version menu. "New version from this one" ("Versi baru dari ini" in Indonesian) copies the open version to `project-<name>.json` and opens it. On the command line, pass the file instead of the folder:

```bash
motlab edit promo/project-tiktok.json
motlab render promo/project-tiktok.json
```

The output is named `<folder>-<version>.mp4`, with a leading `project-` left out: `promo-tiktok.mp4`. `project.json` is shown as "Main" ("Utama") and renders to `promo.mp4`.

## Scene pages

A scene is an HTML page that keeps the [page contract](cli.md#page-contract): a `<canvas id="c">`, `window.renderAt(t)`, `window.TOTAL` and `window.ready`. Everything on screen must be a function of `t`. No timers, `requestAnimationFrame` loops or unseeded randomness, because the renderer calls `renderAt` for frames in any order and as fast as it can.

The skill's [templates](../skills/motlab/templates) are starting points for scenes: 2D canvas, UI panels in 3D (`gl3d.js`), three.js and p5.js. The three.js and p5.js ones draw into their own canvas and copy it onto `#c`, and they load the library from a CDN with an exact version, so rendering them needs the network.

The renderer and the viewer serve a few files for scene pages at fixed paths, so a page imports them the same way in both:

| Path | What it is |
|---|---|
| `/__motlab/footage.js` | decodes video files inside the page ([Footage](#footage)) |
| `/__motlab/cuts.js` | plays a cut list over one recording ([Cut lists](#cut-lists)) |
| `/__motlab/motion.js` | easings, CSS `cubic-bezier`, exact springs, keyframes, stagger and motion blur, all pure functions of time |
| `/__motlab/transitions.js` | the scene transitions, also usable inside a page to mix two canvases |

The skill's `references/motion-and-libraries.md` lists what is in `motion.js` and how GSAP, Anime.js, Lottie and Theatre.js are driven from `renderAt`.

Opened by hand, a template plays on a loop. Inside the viewer (an iframe) or with `?t=`, it draws only when `renderAt` is called. A scene of your own that loops with `requestAnimationFrame` should do the same: in the viewer, a three.js scene that kept its loop running drew 900 frames in 3 seconds while nothing played, against none with the check.

## Rendering a project

```bash
motlab render example
motlab render example out/promo.mp4 --scale 1
```

This renders every scene, joins them and adds the audio. The result is `example/out/example.mp4` unless you give a path. The default `--scale 2` turns 1920x1080 pages into 4K; `--scale 1` gives 1080p. The viewer's Export button does the same thing at a resolution you pick.

To change one scene without rendering the rest again, pass `--only` with its number: `motlab render example --only 3`. The scenes you name are rendered again, the transitions touching them too, and every other scene comes from the cache in `~/.cache/motlab/parts` (`%LOCALAPPDATA%\motlab\parts` on Windows, or `MOTLAB_CACHE_DIR`), where a full render leaves each scene's part. A finished render removes the cached parts it did not use, so the cache holds the parts of the last render only: pass the same `--scale` as that render (for a 1920x1080 page, the viewer's 4K Export is `--scale 2` and 1080p is `--scale 1`), or every scene is rendered again. A scene with no cached part is rendered, so `--only` on a project that was never rendered works like a full render.

A cached part also remembers every local file its page loaded: the page itself, a shared script, a stylesheet, a font, a picture, a clip, and for a transition the two scene pages it shows in its iframes. Before a part is reused, each of those files is hashed again; if one has changed, that part is rendered again, and so is any transition that loads it. A scene that does not load the changed file still hits the cache. So after editing a shared `lib.js`, a plain `motlab render example --only 3` re-renders scene 3 (the one you named) and every other part that loads `lib.js`, and leaves the rest. A file that the page loads but that is now missing, or that fails to load, stops the render with an error that names the scene and the file, rather than reusing the old frames. The list comes from the requests Chrome made while the page rendered, so it sees whatever the page really loaded, including a `fetch` or a module a transition layer imports. The list lives in `deps/` beside the parts; a part with no list is rendered again rather than trusted, which is what happens to parts made by a version before this one. A finished render prunes only the parts under keys it did not use, along with their lists; a render that fails or is cancelled prunes nothing, so the parts it finished stay for the next run.

How it works:

- Each scene is rendered to its own MP4, and ffmpeg joins them with `-c copy`. A full render also leaves each part in the cache, so `--only` can reuse it later.
- The first scene picks the encoder, and every later scene is forced to the same encoder and codec, because a stream copy join is only safe when codec, encoder and resolution match.
- Scenes are joined with hard cuts, unless a scene has a transition. A transition is rendered as a part of its own between the two scenes, and their own parts leave out those frames.
- ffmpeg mixes the audio into one WAV first (`adelay`, `volume`, `amix`), and the final pass muxes it in as AAC.
- Every scene and every transition is a part with its own Chrome (about one second to start) and one ffmpeg pass. The first scene renders alone, because it picks the encoder. The other parts then render several at a time, each in its own Chrome, and are joined in order. A transition waits for the scene before it, which tells it where that scene ends.
- `--parallel` sets how many render at once. The default is 3, but never more than one per 4 CPU threads or per 1 GB of free memory, so a 4-thread machine renders one at a time. Each part's log is printed in one piece when it finishes. If a part fails while several run (too little memory, or more hardware encoder sessions than the GPU allows), the others stop, the finished parts are kept, and the parts still missing are rendered one at a time. A part that fails then too stops the render with its own error, which names the scene or transition and its file; no output is written. The parts that had already passed their check stay in the cache for the next run, and a render that stops part way removes nothing.
- A cancelled render (the viewer's Cancel, or a signal that aborts it) writes no `.part` and no output, removes its temp folder, and leaves the parts already in the cache alone.
- Measured on the test laptop (Ryzen 7 5800H with 16 threads, RTX 3060 Laptop) on a project of 12 two-second 1920x1080 scenes joined by 11 half-second transitions: 78 s one at a time, 49 s two at a time, 45 s three at a time and 41 to 47 s four at a time at 1080p; 93, 62, 53 and 51 s at 4K. With 160 shadowed shapes per frame, 4K took 94, 64, 53 and 52 s. Three at a time used about 2.5 GB of memory for the Chrome processes at 4K. The example project went from 12.7 to 13.1 s to 8.9 to 9.6 s at 1080p, and its MP4 came out identical. Not tried yet: a machine with fewer threads or less memory, and a GPU whose encoder sessions run out.

## Transitions

```json
"scenes": [
  "scenes/01-hook.html",
  { "file": "scenes/02-demo.html", "transition": { "type": "crosswarp", "duration": 0.5, "ease": "inOutCubic", "params": {} } }
]
```

The transition is set on the scene it leads into. For `duration` (rounded to whole frames, at least one), the two scenes overlap: the scene before keeps playing its last frames while the new one plays its first, and the two are mixed. Scene 2 therefore starts 0.5 s before scene 1 ends, and the video is 0.5 s shorter than the sum of the scenes. Audio `start` times are times in the finished video and do not move by themselves.

Frame `k` of an `n`-frame transition shows frame `TOTAL * fps - n + k` of the scene before and frame `k` of the new one, mixed at progress `ease((k + 0.5) / n)`, so neither end of the transition repeats a plain frame. A scene must be longer than its transitions together: a scene with one leading into it and one leading out needs more frames than the two have between them.

`type` is one of 11 shaders from [gl-transitions](https://github.com/gl-transitions/gl-transitions) 1.43.0, all MIT, copied into `src/page/transitions.js` with their authors: `fade`, `fadecolor`, `Directional`, `directionalwipe`, `directionalwarp`, `circleopen`, `CrossZoom`, `crosswarp`, `SimpleZoom`, `LinearBlur` and `cube`. `params` overrides their uniforms (for example `{ "direction": [1, 0] }`), and `ease` is a name from `motion.js`. An unknown type or ease stops the render and the viewer with the list of valid names.

### A layer over the cut

A transition can also be a layer of shapes drawn over a hard cut, such as a swish of brand-coloured bands, instead of a shader that mixes the two scenes. It is an option, not the default: the skill still designs each transition frame by frame in the scene pages, and uses a layer only when the user asks for one. Set `layer` to a JavaScript module in the project in place of `type`:

```json
{ "file": "scenes/02.html", "transition": { "layer": "assets/kits/acme/transitions/swish/transition.js", "duration": 0.6 } }
```

The module exports `draw(ctx, p, W, H)`, which draws the layer at progress `p` in the page's own pixels (`W` by `H`, before `?scale=`), and may be async. The asset skill's `templates/transition.js` is one. The scenes do not overlap and the video keeps its length: the layer covers the last half of `duration` of the scene before and the first half of the next, and `p` runs from 0 to 1 over those frames, reaching 0.5 at the cut. Of `n` frames, the scene before gives the last `floor(n / 2)` and the next scene the first `n - floor(n / 2)`, and frame `k` is drawn at `p = (k + 0.5) / n`. At `p = 0.5` the layer must cover the whole frame, or the cut shows through. The render draws it on the transition part like a shader transition, the viewer draws it over the preview, and the module's file is part of the cache key. `ease` and `params` do not apply: the layer eases itself.

Tested: `test/render.test.js` renders two flat scenes with a layer that draws a red bar `p` of the width, at `--scale 2`, and checks the frame count (no frames lost) and where the bar is before and after the cut. The asset skill's swish between the example's first two scenes was fully covering at the cut and showed the same picture 0.2 s after it in the viewer and in a 1080p render, and the project stayed 9 s long. Not tried: a layer that loads its own images or fonts.

### A transition of your own

`type` can also be a path to a `.glsl` file in the project folder:

```json
{ "file": "scenes/02.html", "transition": { "type": "transitions/swipe.glsl", "duration": 0.6, "params": { "softness": 0.1 } } }
```

The file is written like a gl-transitions shader. It defines `vec4 transition(vec2 uv)`, reads the two scenes with `getFromColor(uv)` and `getToColor(uv)`, and may use `progress` (0 to 1, after `ease`) and `ratio` (width divided by height), which motlab sets:

```glsl
// a soft-edged wipe from left to right
uniform float softness; // = 0.05

vec4 transition(vec2 uv) {
  float edge = progress * (1.0 + softness);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(edge - softness, edge, uv.x));
}
```

Each uniform the file declares can be set from `params`. A float, int, bool, vec2 to vec4 or ivec2 to ivec4 works; a texture (`sampler2D`) does not. A comment right after the declaration gives the default, as gl-transitions writes it: `// = 0.05`, `// = vec2(1.0, 0.0)`, `// = true` or `/* = 0.4 */` before the semicolon. A uniform with no default and no param is 0. Do not declare `progress` or `ratio`. A shader from gl-transitions that uses no texture can be copied in unchanged; keep its author and licence lines at the top.

The viewer and the render compile the file before the first frame, so a mistake stops both with the compiler's message, for example `transition transitions/swipe.glsl: ERROR: 0:6: 'edg' : undeclared identifier`, where 6 is the line in the file. The file's contents are part of the cache key, so after editing it, `--only` renders that transition again.

The render draws a transition with `__motlab/transition.html`, a page that loads both scene pages in iframes and mixes their canvases with WebGL2. The viewer mixes the same two canvases with the same code. On the example project with a `crosswarp` and a `cube` transition, a transition frame in the viewer and in the 1080p MP4 differed by 1.37 levels of 255 on average, with 0.2% of values more than 8 apart, at the edges, from the H.264 compression.

Tested: the example's scenes with two transitions (7.6 s, 228 frames, the frame count and length expected), a 1080x1920 project of two footage scenes joined by `directionalwarp`, and `test/render.test.js`, which checks that a 15-frame linear fade from black to white is at mid grey on its eighth frame. A 12-scene project with all 11 types, one into each scene, gave 555 frames and 18.5 s as expected, and every scene showed its own colour and clock in the middle of its plain stretch. It took 57 s at 1080p, mostly from starting Chrome for 23 parts. Not tested: a transition between scenes of different sizes in the viewer, where the new scene is stretched to the size of the one before (the render refuses such a project).

## Footage

Scene pages can draw video files. The renderer and the viewer both serve `/__motlab/footage.js`, which decodes a file inside the page with Mediabunny (WebCodecs):

```js
let clip;
window.ready = (async () => {
  const { openFootage } = await import('/__motlab/footage.js');
  clip = await openFootage('../footage/demo.mp4');   // relative to the page, like an <img src>
})();
window.renderAt = async t => { await window.ready; (await clip.frame(12.5 + t)).draw(ctx, 0, 0, W, H); };
```

- `clip.frame(t)` returns the frame shown at `t` seconds into the file. It is a Mediabunny `VideoSample` and stays valid until the next call.
- Sequential calls decode each frame once. A jump backwards or far ahead seeks from a keyframe.
- Rotation metadata (phone footage) is applied by `draw`. For a WebGL texture, use `toCanvasImageSource()`.
- Both servers answer Range requests, so long files are read in pieces.
- The footage's sound goes in `project.json` as an audio entry with `from` and `duration`.

Tested: a 60 fps clip trimmed from 1.5 s into a 30 fps scene renders the exact source frame for every output frame, also with three workers starting partway through; a portrait 1080x1920 project with a portrait clip; playback in the viewer. Each frame of the test clips carried its own number in a strip of black and white squares, so every output frame could be checked against the frame the file shows at that time:

- A 20-minute 1280x720 recording (1.1 GB, a keyframe every second): stills at 0.5, 600.2, 1199.9, 30, 1100.1, 2 and 2.03 s, in that order, all showed the right frame, in 1.7 s for the whole command. Ten seconds from 19:40 rendered at 94 fps, every frame right.
- Variable frame rate (portrait 1080x1920, 30 fps with uneven gaps for 5 s, then 60 fps): 435 frames at 30 fps, every one the frame shown at that time.
- HEVC 8-bit (Main) and 10-bit (Main 10) at 1080p: 300 frames each, every one right, at 53 fps. Colour matched an H.264 source of the same picture.
- VP9 in WebM and MP4, and H.264 in MKV, MP4 and MOV, at 24, 25, 29.97, 30 and 60 fps, rendered at 30 fps and at the clip's own rate: every frame right, in 64x64 test clips where each frame is a different grey. WebM and MKV store timestamps in whole milliseconds, so for them `clip.frame(t)` rounds `t` to the millisecond.

These were made with ffmpeg, not filmed on a phone, and played by a Chrome that could decode HEVC on this laptop. Chrome on a machine without HEVC decoding stops at `openFootage` with "this browser cannot decode".

## Cut lists

For a talking head with many jump cuts, cut the pauses out of the recording instead of making one scene per cut. The skill's `cut_pauses.py` finds the pauses in the sound with ffmpeg `silencedetect` and writes the parts to keep, and with `--audio-out` also the voice with the same cuts:

```bash
python skills/motlab/scripts/cut_pauses.py footage/talk.mp4 cuts.json --start 1.4 --audio-out audio/voice-cut.wav
```

A scene then plays the cut list with `/__motlab/cuts.js`:

```js
const { cutList } = await import('/__motlab/cuts.js');
const edit = cutList(await (await fetch('../cuts.json')).json(), clip, { punch: [1, 1.12], glide: 0.25, drift: 0.008, x: 0.5, y: 0.42 });
window.renderAt = async t => { await window.ready; await edit.draw(ctx, t, 0, 0, W, H); };
```

- Each part is framed to cover the scene, zoomed by `punch` in turn (wide, then closer, then wide) around the point `x`, `y` (fractions of the recording), so the jump cuts read as deliberate. A segment in the JSON can set its own `zoom`, `x` and `y`.
- `glide` eases the zoom from the previous part over that many seconds instead of jumping, and `drift` pushes in slowly, per second.
- `--dissolve 0.12` in `cut_pauses.py` overlaps the parts and fades between them, in the picture and the sound. A dissolve draws two parts at once, so `cutList` needs a second `openFootage()` of the same file as `clip2`.
- `edit.parts[k].at` is where part `k` starts in the edit, for sound effects on the cuts, and `edit.toOut(seconds)` maps a time in the recording (a word from a transcript) to the edit.

Tested on the first 40 s of a 1440x1440 talking-head recording: 10 parts, 38.64 s of take to 33.47 s, and the cut voice WAV was the same length as the cut list, with and without a 0.12 s dissolve. A 1080x1920 render of two 12 s scenes from it encoded at 55 to 72 fps on the test laptop (RTX 3060 Laptop). A whole 10-minute take (Windows text to speech with pauses of 0.4 to 2.5 s, over a pink noise room tone) went from 619.4 s to 384.4 s in 240 parts in 60 s. No part starts or ends inside a word: the clean voice is at least 38 dB below its speech level in the first and last 20 ms of every part. None of the 239 joins in the cut voice WAV clicks. Listened to with earshot: no clipping, the same loudness through the take (-20 LUFS), and 0.3 s gaps where sentences meet. A synthetic voice says little about how natural a real person sounds with these settings, so listen to the first real take.

### One take over several scenes, with captions

A long take can be split into scenes by section, so the viewer, notes and `--only` work per section. Name the sections and where each starts, in seconds of the recording:

```bash
python skills/motlab/scripts/cut_pauses.py footage/talk.mp4 cuts.json --audio-out audio/voice-cut.wav --sections hook=0,demo=41.5,outro=96
```

That adds `"sections": [{ "name": "hook", "from": 0 }, ...]` to `cuts.json` (it can also be written by hand) and prints where each section lands in the edit. Each scene then plays its own section, and its `TOTAL` is that section's length:

```js
const edit = cutList(cuts, clip, { section: 'demo', punch: [1, 1.12], glide: 0.25 });
window.TOTAL = edit.duration;   // set it before window.ready resolves
```

- A section starts at the cut nearest its `from` and runs to the cut where the next section starts, so a scene never starts in the middle of a part. Scene time 0 is that cut.
- `edit.offset` is where the section starts in the whole edit. Put the scenes in `project.json` in section order with hard cuts, and the cut voice once at `start: 0`: the scenes' lengths add up to the cut list's, so the voice stays in step. With a dissolve, a section ends where the next one's first part starts, so the dissolve at that cut becomes a hard cut in the picture while the voice keeps its crossfade. A scene transition between sections would shorten the video and move the voice out of step.
- `punch` alternates over the whole list, as it would in one scene.

`edit.captions(transcript)` places a transcript of the recording on the scene's time and groups it into lines for burned-in captions. The transcript is Whisper's JSON with word times (`{ "segments": [{ "words": [{ "word", "start", "end" }] }] }`, from `whisper talk.mp4 --word_timestamps True --output_format json` with OpenAI's Whisper), or a plain list of `{ "text", "start", "end" }`, in seconds of the recording. motlab does not make the transcript.

```js
const lines = edit.captions(await (await fetch('../transcript.json')).json(), { maxChars: 32, maxGap: 0.6, hold: 0.3, shift: 0 });
const line = lines.find(l => t >= l.start && t < l.end);   // { text, start, end, words: [{ text, start, end }] }
```

Words that start inside a cut pause, or outside the section, are left out. A line ends at a pause longer than `maxGap` seconds, after a word ending in `.`, `?` or `!`, or before it would pass `maxChars` characters, and stays up `hold` seconds after its last word unless the next line starts sooner. `shift` moves every word by that many seconds before it is placed: Whisper's word times were about 0.23 s early in one take, so check by ear. Each word has its own time for a word-by-word highlight.

Tested: `test/cuts.test.js` checks where sections start and that they add up to the whole edit, with and without a dissolve, and how captions are placed and broken into lines; `test/render.test.js` renders two section scenes from one recording whose frames each have their own grey and checks that all 24 output frames show the right source frame. `cut_pauses.py --sections` on a made-up 8 s take printed the same section starts and lengths as `cutList`. Not tried: a real transcript from Whisper (its JSON shape is from its documentation) and a real talking-head take split into sections.

The skill's [footage reference](../skills/motlab/references/footage.md) covers editing footage into a video.
