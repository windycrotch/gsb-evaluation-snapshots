# Third-party notices

motlab's own code is under the [MIT licence](LICENSE). This file lists code from other projects that is copied into the repository, with the licence it came under. The example project's sounds in `example/audio/` were made by the maintainer for this repository and are under the same MIT licence.

## gl-transitions

The 11 scene transition shaders in `src/page/transitions.js` are copied from [gl-transitions](https://github.com/gl-transitions/gl-transitions) 1.43.0. Each shader's author is named next to it in that file. `SimpleZoom` is changed so it compiles in WebGL.

```text
MIT License

Copyright (c) 2017-present gl-transitions contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Installed, not copied

These are downloaded when you install or run motlab, under their own licences, and are not part of this repository:

- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), installed by `npm ci`. It writes MP4 files and decodes footage inside scene pages.
- The libraries that scene pages load from jsDelivr at a pinned version, when a scene uses them: three.js (MIT), p5.js (LGPL-2.1), GSAP (its own no-charge licence from Webflow), Anime.js (MIT), lottie-web (MIT), dotLottie (MIT) and Theatre.js core (Apache-2.0).
- Remotion, HyperFrames and GSAP in `bench/`, installed only when you run the benchmark. See [bench/README.md](bench/README.md).
