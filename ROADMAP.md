# Roadmap

What is not built, what has not been tested, and ideas that came up while using motlab. Nothing here is promised.

## Not built yet

- Alpha output (ProRes 4444).
- Rendering only the scenes that changed. Scenes are already separate MP4 parts joined with `-c copy`, so re-rendering one scene and joining again would be cheap. It needs an explicit option such as `--only 7`.
- Rendering several scenes at once in an export. Scenes render one after another today, and Export uses one Chrome. Parallel workers need a safe default for machines with less memory or a hardware encoder session limit, and a fallback to fewer workers when one fails. A project of many short scenes pays a Chrome start per scene: 12 two-second scenes with 11 transitions took 57 s at 1080p.
- The viewer on a VPS with a domain. That needs security in front of it, or access only through Tailscale, which is also worth considering. From there, work could be run remotely on the personal laptop (when it is on) or on the VPS (when there is one).
- Custom GLSL transitions from a file in the project. A transition as a layer over the cut (a swish of shapes) already exists as the asset skill's `transition.js`, but each of the two scene pages has to draw its half by hand; `project.json` has no option for it.
- A cut list that splits one recording over several scenes by section, with captions placed from a transcript. `cuts.js` has the time map (`toOut`), but each section page still picks its part of the list by hand.
- Moving or resizing a note's box after it is drawn. Today the note has to be deleted and drawn again.
- Clearing done notes in one go. They fold under Done, but `selection.json` keeps every one until it is deleted by hand.

## Not tested yet

- The benchmark against Remotion and HyperFrames on macOS and Linux, with their own downloaded browsers, and on scenes heavy on text, images or footage. It was one scene on Windows, at 1080p and 4K.
- macOS, and Linux beyond the tests, including `motlab update` there. On Linux, CI renders the end-to-end tests on an Ubuntu runner; no real video has been made there. On macOS the Chrome paths and the Metal flag are in the code, but nothing has run.
- Renders longer than 10 minutes, and a 10-minute render on a machine that is doing nothing else.
- A machine without a GPU beyond the tests. CI runs the end-to-end tests on Linux and Windows runners without a GPU, and the benchmark ran with Chrome drawing on SwiftShader on the test laptop (1080p and 4K, in `docs/rendering.md`), but no real video has been rendered on such a machine, and no 3D (WebGL) scene.
- Footage filmed on a phone (variable frame rate and HEVC were tested with files made by ffmpeg), and HEVC on a Chrome that cannot decode it.
- Scene transitions between scenes of different sizes in the viewer, and in a normal Chrome window. The render refuses scenes of different sizes.
- The cut voice from `cut_pauses.py` on a real person's take. The whole-take test used Windows text to speech.
- Rive, Lottie text layers exported with glyphs, Theatre.js state exported from its studio, and the studio inside the viewer.
- p5.js `loadFont` and p5 add-on libraries.
- The asset skill (`motlab-assets`) on a real brief and a kit used in a real video. Its scripts were run on a test kit: an SVG character with a rig, a transition, a mug on both 3D paths and a Rigify figure.
- MPFB, which was not installed on the test laptop.
- The asset skill's FBX and OBJ files in programs other than Blender (Unity, Unreal, Maya, Cinema 4D).
- `svgparts.js` and `transition.js` in the viewer. They were checked with stills and a video render.
- Notes on a real touch screen. Touch was emulated in Chrome over the DevTools protocol.
- The skills in agents other than Claude Code. The installer was run with `--dry-run` for every target, and the folders come from each agent's docs, but no other agent has loaded the skills or made a video with them yet.

## Questions about speed

- Whether Chrome can be made to use NVENC on NVIDIA cards. On the test laptop `nvidia-smi` showed no encoder sessions during a hardware encode, so Chrome probably used the integrated GPU's encoder.
- Why the hardware encoder at 4K switches between about 34 and 17 fps from run to run.
