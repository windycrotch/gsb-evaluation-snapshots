# Nanite: how it works, who has rebuilt it, and how to mimic it in three.js

11 Nov 2026. Companion to [REPORT.md](REPORT.md) (measurements) in the same folder. "The prototype" below is the code in this repository; the test meshes it mentions were six AI-generated props that are not included here. Detailed notes with every source link and a read / not-verified mark per fact are in `research/browser-capabilities.md` and `research/reimplementations.md`.

## What the research changed

Reading the primary sources changed the prototype in three ways and sharpened one conclusion. Numbers are in section 4.

1. **Streaming was added.** Karis is explicit that "virtualized" means only a valid cut of the hierarchy has to be in memory, with the top always resident. The output file is now ordered coarsest level first, so "everything down to level L" is a prefix that the page fetches with HTTP Range requests on demand.
2. **Occlusion culling was added.** Nanite's two-pass scheme tests bounds against the previous frame's depth pyramid. The prototype now does the first half of that on the CPU from an asynchronous depth readback, per prop instance.
3. **The error estimate got the edge-length limit** from meshoptimizer's `clusterlod.h` as an option.
4. **A 1 px threshold really does mean about one triangle per pixel, and Nanite pays for that with a software rasteriser.** Nanite's own demo frame rasterises 25M triangles at roughly 2496x1404. The browser has no equivalent that helps an integrated GPU, so the practical operating point for normal-mapped props is a 4 to 8 px threshold or a triangle budget.

Not adopted, with reasons in section 3: visibility buffer, software rasterisation, GPU-side culling, METIS partitioning.

## Sources and how they were read

| Source | Status |
|---|---|
| Karis, Stubbe, Wihlidal, "Nanite: A Deep Dive", SIGGRAPH 2021 Advances course. [Slides with speaker notes (PDF)](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf) | **Read in full** by me: text of all 155 slides and notes. Everything in section 1 not otherwise marked comes from here. |
| Epic docs: [Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-US/unreal-engine/nanite-virtualized-geometry-in-unreal-engine), [Nanite Technical Details](https://dev.epicgames.com/documentation/unreal-engine/nanite-technical-details?lang=en-US), [Nanite Foliage](https://dev.epicgames.com/documentation/unreal-engine/nanite-foliage?lang=en-US) | Read through a fetch tool that returns an extract, not the raw page. Numbers are as that extract reported them. Page header says UE 5.9. |
| Wihlidal, "Nanite GPU Driven Materials", GDC 2024. [Slides (PDF)](https://media.gdcvault.com/gdc2024/Slides/GDC+slide+presentations/Nanite+GPU+Driven+Materials.pdf) | **Not read directly.** Known only through [Scthe's notes on the talk](https://scthe-github-io.vercel.app/blog/nanite-materials-notes). |
| Karis, "The Journey to Nanite", HPG 2022 keynote | Listed in the [HPG 2022 programme](https://highperformancegraphics.org/2022/program); no slides found. Not read. |
| Unreal Engine source for Nanite | Not read. It needs an Epic-linked GitHub account. |
| Epic talks on Nanite tessellation or skeletal meshes | None found. Only the documentation pages above. |
| Virtual shadow maps | Karis 2021 slides (read). Epic's [VSM page](https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine) seen as search snippets only. |
| meshoptimizer `demo/clusterlod.h` | Read in full earlier (the preprocessor follows it). [Repository](https://github.com/zeux/meshoptimizer). |
| Browser and three.js capabilities | Researched by a sub-agent; each fact marked in `research/browser-capabilities.md`. |
| Reimplementations | Researched by a sub-agent; each fact marked in `research/reimplementations.md`. |

## 1. How Nanite works, stage by stage

Each stage lists what Nanite does, then what the prototype does.

### Why triangles, and the goal

Karis rejects voxels, subdivision surfaces, displacement maps and points for this job and keeps triangles with UVs, so existing art pipelines stay. The stated goal is that cost should follow screen resolution, not scene complexity: "there are only so many pixels on screen. Why should we draw more triangles than pixels?"

### Clusters and the cluster DAG

- Leaf clusters are **128 triangles**, built by graph partitioning (METIS) of the mesh's dual graph. The partitioner optimises for few boundary edges under a strict size cap.
- Build loop: group clusters, merge their triangles, **simplify to 50%**, split back into 128-triangle clusters, repeat until one cluster remains.
- Boundaries of a group are **locked** during simplification, so the simplified group can replace its children without cracks.
- Grouping is another graph partition. Nodes are clusters, edge weight is the number of shared triangle edges, and extra edges link spatially close but unconnected clusters so islands are not grouped arbitrarily. Groups hold **8 to 32 clusters**.
- Because groups are re-chosen at every level, a boundary that is locked at one level is interior at the next. That makes the structure a DAG, not a tree, and stops "dense cruft" from collecting along a boundary that never unlocks.
- Prior work it builds on: Quick-VDR and Batched Multi-Triangulation.

Prototype: same loop with meshoptimizer's clusterizer and simplifier. Grouping is a hand-written heavy-edge matching (the JS build lacks `meshopt_partitionClusters`, and METIS was not used), about 14 clusters per group, with a spatial fallback for islands. Since the preprocessor is offline, a native build of `clusterlod.h` would be a drop-in improvement.

### Simplifier and error metric

- Edge collapse with a quadric error metric that includes attributes and **optimises new vertex positions**.
- Karis calls the error estimate "the hardest part", about a person-year of work. Position and attribute error are mixed with weights, which he calls a heuristic with no theory behind it.
- The fix that mattered: normalise by **average triangle area per group**, so a small part of a big mesh and a small distant mesh simplify alike. This made the triangle count per frame "basically constant" across demo scenes.
- "Edge length limits" are listed as part of the tuning.

Prototype: meshoptimizer's attribute-aware simplifier, which only collapses onto existing vertices. Error is in absolute units of the group handed to it, which gives a similar per-group normalisation. Where edge collapse stalls it falls back to vertex clustering, which Nanite does not do; that fallback is the source of the smeared textures and blobby thin parts in `REPORT.md`.

### Choosing the cut at run time

- Every cluster in a group stores the **same error and bounding sphere**, so they decide alike without talking to each other.
- Draw a cluster when `ParentError > threshold && ClusterError <= threshold`. This is local, so it can run in parallel.
- It is only correct if the projected error is **monotonic** up the DAG. The build forces a parent's error and bounds to be at least its children's.
- Error is projected at the worst-case point inside the sphere.
- No geomorphing. With error under one pixel, temporal anti-aliasing hides the switch.
- Known weakness: selection is isotropic, so surfaces at glancing angles are over-tessellated.

Prototype: the same test and the same monotonic rule. `three-nanite verify` found no monotonicity violations and no cracks. There is no temporal anti-aliasing in the test page, so thresholds above 1 px rely on normal maps to hide the switch.

### Hierarchical culling and persistent threads

- Testing every cluster is wasteful, so Nanite builds a **BVH with 8 children per node** over cluster groups, keyed on the maximum `ParentError` below each node. It does not walk the DAG.
- The naive GPU traversal needs one dispatch per tree level. Nanite instead runs **one dispatch of "persistent threads"** that pull from a shared job queue, 10 to 60% faster. It relies on scheduling behaviour that D3D and HLSL do not define.
- Frustum and occlusion tests happen in the same traversal, for instances, then nodes, then clusters.

Prototype: a CPU walk of the DAG from the root, with frustum tests on groups and clusters. It visits only the groups around the cut and costs 0.4 to 1.2 ms per frame for the 96-prop scene. A GPU traversal would save about a millisecond, so it was not built.

### Two-pass occlusion culling

- Occlusion uses a hierarchical depth buffer (HZB): project the bounds to a screen rectangle, pick the mip where it covers at most 4x4 texels, compare depth.
- Pass 1 tests against the **previous frame's HZB with the previous frame's transforms** and draws what passes. Then the HZB is rebuilt, and pass 2 retests what failed and draws anything newly visible.
- Karis: reliance on previous-frame depth is "one of Nanite's biggest deficiencies". Closely stacked surfaces and foliage overdraw badly because culling is per cluster, not per pixel.

Prototype (new): pass 1 only, per prop instance, on the CPU. See section 4.

### Visibility buffer and rasterisation

- Rasterisation writes only **depth, visible-cluster index and triangle index** per pixel. Materials run later, once per pixel.
- Hardware rasterisers are built for big triangles and set up roughly four triangles per clock. Nanite's **compute-shader rasteriser is about 3x faster** on small triangles. Clusters whose triangles are under 32 pixels long go to it; the rest go to the hardware rasteriser.
- Depth testing without hardware is a **64-bit atomic max** on a packed value: 30 bits depth, 27 bits cluster index, 7 bits triangle index.
- Demo frame: 199,420 clusters, **25,041,711 triangles** rasterised, about 2.5 ms for the whole visibility buffer and about 2 ms for materials, at an average of 2496x1404 before upscaling.

Prototype: ordinary hardware rasterisation with forward shading. This is the stage the browser cannot follow (section 3).

### Deferred materials

- 2021: a full-screen pass per material, using a "material depth" buffer and an equal-depth test so the hardware rejects other materials' pixels. Texture gradients are computed analytically because pixel quads span triangles.
- 2024 (via Scthe's notes on Wihlidal's talk): shading moved to compute with "shading bins", and masked, two-sided and vertex-animated materials got "programmable raster bins". In the quoted example 81% of shading bins were empty and compacting them saved nearly 1 ms.

Prototype: stock three.js materials, forward shaded.

### Streaming

- The streaming unit is the **cluster group**: a cluster cannot be drawn until all its siblings are loaded.
- Groups are packed into fixed-size pages (the notes mention 128 KB), sorted by spatial locality and DAG level. The **root page is always resident**.
- The **culling hierarchy is always resident**, so traversal can look past what is loaded and request every level it needs at once.
- The GPU emits page requests with priorities during culling; the CPU loads, evicts and patches pointers.

Prototype (new): level-granular prefix streaming. See section 4.

### Compression

- In memory: per-cluster quantisation with the minimum bit count per component, about 17 bits per triangle for indices, octahedral normals, no stored tangents.
- On disk: a different encoding meant to be followed by LZ, with strip-based topology at about 5 bits per triangle and about 30% of vertices stored as references to parents.
- Results in the talk: 5.6 bytes per Nanite triangle, 11.4 bytes per input triangle, so 1M input triangles is about 10.9 MB. Epic's docs page gives 14.4 bytes per input triangle (13.8 MB per million) for a sample project.
- Positions are quantised on an object-space grid with a power-of-two step, not normalised to bounds, so modular pieces line up.

Prototype: float positions and UVs, 8-bit normals, 32-bit indices: about 36 bytes per input triangle (67 MB for 1.85M). The meshopt codecs would roughly halve that (estimated by running the encoder). WebGL2 has no usable base-vertex draw, which blocks small per-cluster index types.

### Shadows

- Virtual shadow maps: 16k x 16k virtual maps in 128x128 pages, only pages that visible pixels sample are allocated and drawn, pages are cached across frames, and Nanite renders all shadow views in one multi-view pass with its own LOD per view (default bias 2 px).

Prototype: three.js shadow maps redraw the camera's cut. Nothing like virtual shadow maps is feasible in WebGL2.

### Tiny instances

- The DAG stops at one 128-triangle cluster, so cost stops falling for very small instances. Nanite 2021 used visibility-buffer impostors (12x12 directions of 12x12 pixels, 40.5 KB per mesh) and Karis wanted to replace them.

Prototype: root clusters of 42 to 122 triangles. No impostors.

### Limits Epic states

- 2021 talk: no translucent or masked materials, no deformation, weak on aggregates such as grass and leaves.
- Current docs (extract): opaque and masked only; no morph targets; no forward rendering, VR stereo, MSAA or lighting channels; per-vertex tangents not stored; ray tracing uses a fallback mesh by default; 16 million instance cap. Skeletal meshes, spline meshes, tessellation with displacement, and foliage (assemblies, voxels and bone-driven wind, marked experimental) are now listed as supported.
- Every Nanite mesh also keeps a **fallback mesh** (a plain simplified mesh) for collision, light baking, ray tracing and unsupported platforms. That is the same thing as this report's main recommendation.

## 2. Reimplementations and close relatives

Condensed from `research/reimplementations.md`, which has the full notes, numbers and a verification mark per claim. The sub-agent's fetch tool returns a digest of each page, so "read" below means fetched and digested, not quoted.

| Project | Where it runs | What it has | What it lacks | Reported numbers |
|---|---|---|---|---|
| [meshoptimizer `clusterlod.h`](https://github.com/zeux/meshoptimizer) | C++ library | The reference DAG build: groups of 16, position-based border locks, simplify to 50%, permissive mode, vertex-clustering fallback with doubled error, optional edge-length error limit | No renderer | zeux reports building the 1.64B-triangle Zorah scene's DAG in about 2 min 35 s on 16 cores |
| [Bevy meshlets](https://jms55.github.io/posts/2024-06-09-virtual-geometry-bevy-0-14/) (JMS55) | Native Vulkan and Metal | METIS groups of 8, two-pass HZB occlusion, 64-bit visibility buffer, compute rasteriser for small clusters, BVH culling since 0.17 | Streaming. **No browser support**: it needs 64-bit atomics and the author says a browser demo is not possible | 3,375 bunnies: 4.97 ms down to 0.93 ms between two releases on an RTX 3080 |
| [Scthe/nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | Browser WebGPU (Chrome) | DAG built in the browser with WASM meshoptimizer and METIS, compute culling with a flat per-meshlet test, previous-frame HZB, compute rasteriser, billboard impostors | No visibility buffer. The rasteriser packs 16-bit depth and a normal into 32 bits, so software-rasterised pixels are untextured. No streaming, no two-pass occlusion | Scenes up to 1.7B instanced triangles; no frame rates or GPU given. One 910k model stalled at 180k triangles |
| [three-virtual-geometry](https://github.com/elad12390/three-virtual-geometry) (elad12390) | three.js r180+ `WebGPURenderer` | Compute culling and cut selection, index expansion, one indexed indirect draw per mesh, vertex pulling through a TSL position node so **stock node materials, lights and shadows keep working**, HZB occlusion, dithered LOD cross-fade, a GPU capacity controller, voxel proxies for foliage | Hardware raster only, no visibility buffer, no streaming described, static meshes | Author's own, one Apple M4 Pro: 5.7B source triangles at 160 to 230 fps at 1080p, drawing 6.5M to 9.0M triangles per frame |
| [AIFanatic/three-nanite](https://github.com/AIFanatic/three-nanite) | three.js | DAG build with METIS and meshoptimizer, cut demonstration | Everything after the cut. Last pushed Sep 2024 | A Hacker News user reported 20 to 40 fps on a Celeron with integrated graphics |
| [Usnul, three.js forum thread](https://discourse.threejs.org/t/virtually-geometric/28420) | three.js WebGL (2021-22), WebGPU (2026) | The WebGL version did CPU cut selection first and found per-frame geometry upload the bottleneck. The 2026 system has a **format built for HTTP range requests** | Closed source | 2026: Zorah converted to 50.1 GB, about 2.1 GB streamed in a demo, under 512 MB of video memory |
| [jglrxavpok, "Recreating Nanite"](https://jglrxavpok.github.io/2024/01/19/recreating-nanite-lod-generation.html) | Vulkan, mesh shaders | DAG, mesh-shader drawing | Streaming | Draw time 8.65 ms to 0.8 ms after moving to mesh shaders |
| Unity: official `com.unity.virtualmesh`, UNanite and others | Unity, Vulkan or DX12 | Varies; listed in the notes | | |
| LVSTRI / IrisVk | Vulkan | Repository exists | No write-up found; nothing verified | |

What these agree on, and what it means here:

- **The build recipe has converged** on what the prototype does: about 128 triangles per cluster, 8 to 16 clusters per group, 50% simplification with only true group borders locked by position, and error forced monotonic by taking the maximum with the children.
- **A stalled simplifier is everyone's main quality problem.** Remedies in use: seam protection, permissive mode, vertex-clustering fallback, bigger groups, voxel proxies for foliage, or simply accepting terminal clusters. Several authors shipped a broken monotonic rule or cracked borders before getting it right.
- **METIS is no longer the norm.** The newer projects use `meshopt_partitionClusters` or a greedy grouper, as here.
- **Nobody has Nanite's visibility buffer and software rasteriser working properly in a browser.** Bevy needs 64-bit atomics; Scthe's 32-bit packing loses textures.
- **The one complete three.js implementation is hardware-raster only and WebGPU only**, and it draws 6.5M to 9M triangles per frame at a 1 px threshold. That is fine on an M4 Pro and far beyond the integrated GPU measured here (about 8 ms per million).
- **In WebGL the only evidence is closed source**, and it points to the design used here: geometry resident on the GPU, cut chosen on the CPU, cluster ranges drawn.
- **Distance is handled with budgets, impostors or draw-distance cuts**, not by the DAG alone.

## 3. Ways to do each stage in the browser

"Built" means it exists in this folder. Support facts are from `research/browser-capabilities.md`.

| Stage | Option | Feasible? | Cost to build | Needs | Verdict |
|---|---|---|---|---|---|
| DAG build | meshoptimizer WASM clusterizer + simplifier, own grouping | Yes, built | Done | Node | Good enough. 4 to 6.5 s per 1.9M triangles. |
| | Native `clusterlod.h` / METIS as an offline tool | Yes | Small (compile and wrap) | Native toolchain | Better grouping. Worth doing if the tool is kept. |
| Cut selection | CPU, main thread | Yes, built | Done | Nothing | About 1 ms. Keep. |
| | Web worker | Yes | Medium | SharedArrayBuffer for zero-copy needs cross-origin isolation | Only if the main thread is short of time. Adds a frame of latency. |
| | WebGPU compute, flat test over all clusters | Yes | Medium | WebGPU | The parallel form Karis describes. Saves about 1 ms. |
| | WebGPU compute, persistent threads | Risky | Large | Scheduling behaviour no spec defines | No. Use one pass per level instead. |
| | WebGL2 transform feedback | Barely | Large | WebGL2 | No. |
| Occlusion | CPU test against read-back depth, previous frame only | Yes, built (instances) | Done | Float render target, async readback | Big win where there are walls. Late by a few frames. |
| | WebGL2 occlusion queries | Yes | Medium | WebGL2 | Boolean, a frame late, one query per object. Worse than the above. |
| | Two-pass HZB in WebGPU compute | Yes | Large | WebGPU | The real thing. Only pays off with GPU-driven drawing. |
| Draw submission | `WEBGL_multi_draw` through three's BatchedMesh path | Yes, built | Done | Chrome/Edge 86+, Safari 15+. **Not Firefox.** | Keep. ANGLE loops over the draws internally, so it is not free per cluster. |
| | One `drawElements` per cluster | Yes (three's fallback) | None | WebGL2 | Thousands of calls per frame. Firefox would get this. |
| | Rebuild one index buffer per frame | Yes | Small | WebGL2 | 12 bytes uploaded per drawn triangle per frame. Fallback for Firefox. |
| | Fixed-size clusters as instances, vertex data pulled from textures | Yes | Medium to large | WebGL2 | One draw call everywhere, but custom shaders replace three's materials. |
| | WebGPU loop of `drawIndexed` (three's BatchedMesh) | Yes, tested | Done | WebGPU | Works, not faster. |
| | WebGPU compute culling, index expansion, one indexed indirect draw per mesh | Yes; `three-virtual-geometry` does this with stock node materials | Large to build, or adopt that library (a month old, 2 stars, not tried here) | WebGPU, storage buffers in the vertex stage | The realistic WebGPU design. Does not lower the triangle cost on an integrated GPU. |
| | WebGPU multi-draw indirect | No | n/a | Chrome flag only, 0.13% of adapters | Not usable. |
| Visibility buffer | WebGL2 | Poorly | Large | No `gl_PrimitiveID`; ids need a per-triangle provoking vertex | No. |
| | WebGPU | Yes | Large | `primitive-index` feature (84% of adapters) or a barycentric trick | No browser project has one working with textures. Only worth it with a different material system. |
| Small-triangle rasteriser | WebGL2 | No | n/a | No compute, no atomics | Impossible. |
| | WebGPU compute, 32-bit atomics | Yes, with compromises | Large | WebGPU | Depth and id must share 32 bits. Scthe's project reports heavy artefacts from this. |
| | WebGPU compute, 64-bit atomic min/max | Not yet | Large | `atomic-vec2u-min-max`, in the spec since Sep 2026, shipping status unknown | Revisit when it ships. |
| Materials | Forward, stock three.js | Yes, built | Done | Nothing | Keep. |
| | Depth pre-pass then equal-depth shading | Yes | Small | Nothing | Reasoned from measurements: adds about 10 ms of geometry to save at most 7 ms of shading on the integrated GPU. No. |
| Streaming | Whole file | Built | Done | Nothing | 67 MB per prop. |
| | Level prefix with HTTP Range | Yes, built | Done | A host that honours Range | Simple, coarse. See section 4. |
| | Pages of cluster groups, as Nanite | Yes | Medium to large | Same, plus a page table and eviction | About 4x less data than level prefix in the test flight (estimated). |
| Compression | meshopt codecs | Yes | Small | WASM decoder | About half the size (estimated). |
| | Quantised positions, octahedral normals | Yes | Small | Nothing | Another large cut; not measured. |
| Shadows | Reuse the camera's cut | Yes, works | Done | Nothing | Doubles triangle cost; casters outside the view vanish. |
| | Separate cut per light | Yes | Small | Nothing | Costs a selection and a draw per light. |
| | Virtual shadow maps | No | n/a | n/a | Out of reach. |
| Far and tiny props | Cull below a pixel size | Yes | Trivial | Nothing | Fine for clutter. |
| | Octahedral impostors | Yes | Medium | Third-party library, marked work in progress | Possible; not tried. |
| Cheaper imitations | Automatic discrete LODs from the same simplifier | Yes, built | Done | Nothing | Same cost per triangle; big pops. Simplest thing that ships. |
| | Discrete LODs picked by a scene budget | Yes | Small | Nothing | Not built. |
| | Cluster DAG from pre-reduced sources (60k) | Yes, built | Done | Nothing | 3 MB per prop, runs on the integrated GPU. |

Two support facts matter most for a game that must run everywhere:

- `WEBGL_multi_draw` is missing in Firefox ([registry](https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/), MDN data via the notes), so any shipped version needs the index-rebuild fallback.
- ANGLE implements multi-draw as a CPU loop with `gl_DrawID` as a uniform on D3D11, Metal and Vulkan ([source](https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/renderer_utils.cpp)). That matches the per-range cost seen on the RTX 5090 in `REPORT.md`.

On WebGPU: there is no standard multi-draw indirect ([spec PR 2315](https://github.com/gpuweb/gpuweb/pull/2315), still a draft), no mesh shaders ([issue 3015](https://github.com/gpuweb/gpuweb/issues/3015)), and 64-bit atomic min/max only just entered the spec ([proposal](https://raw.githubusercontent.com/gpuweb/gpuweb/main/proposals/atomic-64-min-max.md)). Chrome's documentation says it ignores `powerPreference` on Windows and tends to use the integrated GPU ([troubleshooting tips](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)); on this machine the opposite happened and both settings returned the NVIDIA adapter.

## 4. What changed in the prototype, with measurements

All measured unless marked. Integrated GPU numbers use the method in `REPORT.md`.

### Streaming by level prefix (`?stream=1`)

- The preprocessor now writes clusters coarsest first and numbers vertices by first use in that order. Loading "down to level L" is one byte range per attribute.
- The hierarchy (errors, spheres, membership) is always resident: 1.1 MB per prop. Geometry starts with a root prefix of at most 96 KB (levels 10 or 11 here).
- Selection treats a group as refinable only if all its member clusters are loaded. Otherwise it draws the coarser cluster and keeps walking the hierarchy without drawing, to find the finest level wanted, so one request fetches everything needed (Karis's point about not streaming the hierarchy).
- Prefix sizes for the crate: 0.4 MB to level 8 (8k finest triangles), 2.8 MB to level 5 (60k), 9.5 MB to level 3 (231k), 66 MB for all.

Data needed for the whole 300-frame flight, 96 props of six types, 405 MB if fully loaded. The flight ends about 1.5 m from two props.

| Setting | Level-prefix streaming (measured) | If streamed per cluster (estimated) |
|---|---|---|
| 2 px threshold | 139 MB (34%) | 45 MB |
| 4 px threshold | 87 MB (21%) | 31 MB |
| 8 px threshold | 70 MB (17%) | 22 MB |
| 300k budget | 69 MB (17%) | 18 MB |

The estimate counts every cluster drawn at least once, at 25 bytes per triangle in the current format. It ignores page slack and the parents a page system would also keep. Level granularity is the weak point: one close-up loads a whole level of that prop. There is no eviction.

### Occlusion culling of instances (`?occ=1`, with `&walls=1` for test occluders)

- The scene renders into a float target with a depth texture and is copied to the screen. A shader reduces depth to a 64x36 farthest-depth map, which is read back asynchronously (three's `readRenderTargetPixelsAsync`) with the view-projection matrix of that frame.
- Each later frame tests every prop's bounding sphere against that map. In the pane the map was one frame old.
- There is no second pass, so a prop that comes into view appears a few frames late. I did not assess how visible that is in motion.

384 props behind and between test walls, camera near the ground, integrated GPU:

| Mode | Occlusion off | Occlusion on |
|---|---|---|
| 2 px threshold, three views | 5.5M to 7.7M triangles, 49 to 75 ms | 0.58M to 2.9M triangles, 18 to 29 ms |
| 300k budget, effective error | 27, 26, 13 px | 6, 16, 11 px |
| Props hidden | 0 | 178 to 264 of 384 |

The extra render target, copy and readback cost nothing measurable (52.7 and 75.3 ms with the path on but the test off, against 57 to 60 and 74 ms without it).

### Edge-length limit on error (`--edge-limit`, off by default)

Caps a group's error at a multiple of its longest short edge, as in `clusterlod.h`. Offline count for the crate at a 1 px threshold with a factor of 0.5: no change closer than 12 m, then 3% fewer triangles at 25 m, 7% at 50 m, 36% at 100 m and 46% at 200 m.

### What a 1 px threshold means for generated meshes (offline count, crate)

| Distance | Height on screen | Triangles at 1 px | Triangles per pixel of the bounding square |
|---|---|---|---|
| 3 m | 765 px | 226k | 0.4 |
| 12 m | 191 px | 91k | 2.5 |
| 50 m | 46 px | 58k | 27 |
| 200 m | 11 px | 12k | 96 |

The stored error of a level is about one triangle edge length, because the AI-generated test meshes carry noise at the scale of single triangles. So the simplifier cannot find big flat areas to spend few triangles on, and a 1 px threshold yields roughly pixel-sized triangles, as Nanite intends. Far away the count falls more slowly than the area. Nanite absorbs this with its software rasteriser; a hardware rasteriser on an integrated GPU cannot.

### Not adopted

- **Visibility buffer and software rasteriser**: no route in WebGL2, and in WebGPU only with 32-bit packing that the one browser project reports as visibly broken.
- **GPU culling**: CPU selection is about 1 ms.
- **METIS**: the hand-written grouping already halves triangles per level down to one cluster, and the newer reimplementations have also dropped METIS.
- **Trying `three-virtual-geometry`**: it is the closest existing thing to a drop-in, but it is a month-old package from a single author, so I did not install or run it. It is WebGPU only, and WebGPU could not be made to use the integrated GPU on this machine.

## 5. Not verified

- The numbers from Epic's pages come from a tool's extract of those pages.
- Wihlidal's GDC 2024 talk is second-hand.
- Whether any browser ships 64-bit atomic min/max.
- How visible late disocclusion and budget-mode shimmer are in motion.
- The per-cluster streaming figures are estimates from clusters drawn.
- Further open items are listed at the end of both files in `research/`.
