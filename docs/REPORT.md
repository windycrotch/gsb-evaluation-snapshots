# Nanite-style virtual geometry in three.js: experiment report

11 Nov 2026. This is the measurement report of the experiment that became this library, lightly trimmed. It was written to answer one question: should a browser first-person shooter, which has to run on integrated GPUs and has a download budget of about 25 MB per map, adopt this technique for its props? That is why the verdict below is about that game and not about the technique in general.

Read the numbers with this in mind:

- The test set was six AI-generated props of 1.85M to 1.97M triangles each with 2048 px PBR textures. They are not in this repository; the demo ships procedural models instead, so you will not reproduce these exact figures.
- Measured with three.js 0.186.1 and meshoptimizer 1.3.0 in Chrome on one machine (integrated AMD Radeon and an RTX 5090).
- File names were updated to this repository's layout. Sections about wiring it into that game, and the list of comparison videos, were removed.

## Verdict for that game: adopt in part

**Use the preprocessor as an automatic decimator and LOD maker. Do not ship the runtime cluster DAG at full density.**

- The technique works in the browser. 96 props with 184M source triangles draw as 0.6M to 2.5M triangles at a 2 px threshold in 7 draw calls, with no cracks, and CPU selection takes about 1 ms.
- It does not solve the actual problem on the target machine. The integrated GPU pays about 8 ms per million drawn triangles at 1080p. Pixel-error LOD wants 1.7M to 4M triangles for the 96-prop test scene (20 to 36 ms). A fixed budget of 300k keeps the frame at 6 to 11 ms, but then each prop gets about 3k triangles, and that is the part of the hierarchy that looks worst.
- Full-density data is far too big: 67 MB per prop for the DAG alone, against a 25 MB download budget for a whole map. Three such props already lose the WebGL context on the integrated GPU. Streaming (added later, see the update below) cuts what is actually loaded to about a sixth under a 300k budget, which is still 69 MB for six prop types.
- The offline tool is the useful part. It turns a 1.9M-triangle generated GLB into any target count, or a set of LODs, in 7 to 17 seconds with UVs and normals intact. That replaces decimating by hand.
- A middle option exists and was tested briefly: pre-reduce each prop to about 60k triangles, then build the DAG (3 MB per prop, six props fit on the integrated GPU). With a 300k budget that scene ran at 5 to 14 ms there. The triangle budget then works as a scene-wide safety cap. It is only worth wiring into the game if props end up dense enough to need it.

## Update after the research pass (same day)

The brief was extended: research how Nanite is really implemented, survey every way to mimic it in the browser, and let that drive the design. The write-up is [RESEARCH.md](RESEARCH.md), with source-by-source notes in `research/`. It changed the prototype and parts of this report:

| Change | Why (source) | Result |
|---|---|---|
| Streaming by level prefix, `?stream=1` | Karis 2021: only a valid cut needs to be resident; the root and the culling hierarchy stay loaded | A 300-frame flight past 96 props needed 69 MB at a 300k budget and 139 MB at 2 px, out of 405 MB. Streaming per cluster would need an estimated 18 and 45 MB. |
| Occlusion culling of prop instances, `?occ=1` | Karis 2021: test bounds against the previous frame's depth pyramid | With walls in the scene, 178 to 264 of 384 props are skipped. At 2 px the frame drops from 49 to 75 ms to 18 to 29 ms on the integrated GPU. |
| Edge-length limit on error, `--edge-limit` | meshoptimizer `clusterlod.h` | Up to 46% fewer triangles beyond 100 m; nothing closer than 12 m. Off by default. |
| File layout is coarsest-first | Needed for the prefix streaming | Same triangle counts and cuts; crack test still passes. |

What it did not change:

- **The verdict.** The integrated GPU still pays about 8 ms per million triangles, and Nanite's answer to that (a compute rasteriser writing a visibility buffer with 64-bit atomics) has no working browser equivalent. Nanite's own demo frame draws 25M triangles.
- **The practical setting.** A 1 px threshold produces roughly pixel-sized triangles on these meshes. For normal-mapped props a 4 to 8 px threshold or a budget is the usable range.

Corrections to the first version of this report:

- I wrote that a GPU-driven WebGPU version would bypass three.js materials. A month-old library, `three-virtual-geometry`, does compute culling and indirect draws inside `WebGPURenderer` with stock node materials. I did not run it (new, single author, WebGPU only).
- `WEBGL_multi_draw` is not available in Firefox, so a shipped version needs a fallback draw path there.
- ANGLE runs multi-draw as a loop of draws on every backend, which explains the per-cluster cost seen on the RTX 5090.

A later integrated-GPU run on the new layout came out about 30% slower across every mode, including the unchanged full-mesh and discrete-LOD baselines (`bench/layout3_std.json`). I read that as machine state after hours of benchmarks, not the layout, but it means the absolute numbers below carry at least that much uncertainty.

## What was built

| Piece | File | Notes |
|---|---|---|
| Preprocessor | `src/build.js`, `three-nanite build` | GLB to cluster DAG, plus four discrete LODs for the baseline. Node, meshoptimizer (WASM). |
| Runtime | `src/clod.js` | `ClodBatch` (drawing), `ClodSelector` (threshold and budget selection), `DiscreteLodSet` (baseline). |
| Test page | `examples/index.html`, `examples/main.js` | Fly camera, sliders, cluster and level colouring, bench and capture hooks. |
| WebGPU check | `examples/webgpu.html`, `examples/webgpu.js` | The same batch object under `WebGPURenderer`. |
| Research | `docs/RESEARCH.md`, `docs/research/*.md` | How Nanite works, reimplementations, browser options per stage, all with sources. |
| Cut statistics | `three-nanite stats` | Triangles in the cut by distance, offline. |
| Crack test | `three-nanite verify` | Counts open edges of selected cuts offline. |
| Raw numbers | `docs/bench/*.json` | Print one with `node examples/bench-table.mjs docs/bench/igpu.json`. |

In the test page, `?stream=1` turns on on-demand loading and `?occ=1&walls=1` turns on occlusion culling with test walls.

### How it works

Preprocessing follows meshoptimizer's `demo/clusterlod.h`. The JS build of meshoptimizer has no `partitionClusters`, so grouping is written here (heavy-edge matching on shared boundary vertices, Morton-order fallback for leftovers).

1. Split into meshlets of at most 128 triangles.
2. Group about 16 adjacent meshlets. Lock every vertex shared between two groups.
3. Simplify each group to half, with attribute-aware edge collapse (normals and UVs weighted, UV seams protected). If that cannot reach 70% of the input, fall back to vertex clustering (`simplifySloppy`) and double its error.
4. Split the result into meshlets again. Each new cluster records the group that produced it. Group error and bounding sphere only ever grow going up.
5. Repeat until one cluster is left.

At runtime a cluster is drawn when its producing group has projected error at or below the threshold and the group that consumes it is above it. Selection walks the DAG from the root on the CPU, with frustum culling per group and per cluster.

Drawing uses one object per prop type that poses as a `THREE.BatchedMesh`. The stock `WebGLRenderer` then issues a single `WEBGL_multi_draw` call per type, and stock materials fetch the instance matrix through `gl_DrawID`. Each selected (instance, cluster) pair is one index range in that call. No custom shader is needed except for the debug colours.

Vertices are stored coarse-level first, so the coarse clusters read a compact prefix of the vertex buffer. This was added after the first measurements and halved the cost (see below).

## Measurements

Unless stated, numbers are **measured** on this machine: Chrome, 1920x1080, `MeshStandardMaterial` with base colour, normal and roughness/metal maps at 2048 px, environment light plus one directional light. Frame time is the median of 30 frames of selection + `render()` + a one-pixel `readPixels` to force the GPU to finish. The empty scene costs about 3.3 ms measured this way on the integrated GPU.

- **Integrated GPU**: AMD Radeon (Ryzen), ANGLE on Vulkan. Run-to-run noise is about 20 to 30%, so treat single values as approximate.
- **Discrete GPU**: RTX 5090, ANGLE on D3D11. The synchronisation floor is 5 to 7 ms and noisy, so only large differences mean anything there.

Raw data: `bench/*.json`. Print with `node examples/bench-table.mjs docs/bench/igpu.json`.

### Preprocessing and file size (six props)

| | Value |
|---|---|
| Source GLB | 66 to 72 MB, 1.85M to 1.97M triangles, about 1.0M vertices, 5,011 UV charts (crate) |
| DAG build | 4.1 to 6.5 s per prop |
| Whole run including LODs and texture resize | 7 to 17 s per prop, single thread |
| DAG shape | about 30,000 clusters, 2,200 groups, 13 to 15 levels, 42 to 122 triangles at the root |
| Output `.bin` | 84 to 86 MB. About 67 MB is the DAG (25 MB vertices, 42 to 45 MB of 32-bit indices). The rest is the discrete-LOD baseline. |
| With meshopt codecs | 31 to 34 MB estimated by running the encoder. The decoder is not wired into the page. |
| Groups that needed the vertex-clustering fallback | 1 to 46 of about 2,200 per prop, first appearing at level 5 (generator, crate) to level 13 (barrier) |
| Pre-reduced to 60k triangles first (`--max-tris 60000 --tex 1024`) | 2.8 to 3.3 MB per prop, 8 to 15 s |

### One prop: source versus drawn triangles

Crate, 1.85M source triangles, scaled to 2 m, 1080p, 60 degree field of view.

| Distance (m) | DAG 1 px | DAG 2 px | DAG 4 px | Discrete LOD 1 px |
|---|---|---|---|---|
| 1.5 | 280k | 195k | 143k | 462k |
| 3 | 204k | 141k | 98k | 462k |
| 6 | 129k | 93k | 79k | 116k |
| 12 | 91k | 77k | 63k | 116k |
| 25 | 77k | 59k | 35k | 29k |
| 50 | 58k | 35k | 14k | 29k |
| 100 | 35k | 12k | 5.2k | 6.8k |
| 200 | 12k | 5.2k | 5.2k | 6.8k |

The counts stay high far away. At 200 m the crate is about ten pixels tall and still draws 5k triangles at a 4 px threshold. The error recorded for the top levels is pessimistic (fallback error is doubled and normals count towards error), so the pixel threshold alone never reaches game-like counts.

Integrated GPU frame time for this single prop at 3 m: full mesh 9.7 to 11.4 ms, DAG at 1 px 5.9 to 6.8 ms, discrete LOD 7.3 to 7.5 ms.

### 96 props, integrated GPU

Two prop types (crate, tyres), 182.5M source triangles. Frame ms, with drawn triangles in brackets.

| Camera distance (m) | DAG, 2 px | Discrete LODs, 2 px | DAG, budget 300k (effective error) |
|---|---|---|---|
| 3 | 22.8 (1.66M) | 30.6 (3.71M) | 11.3 (19 px) |
| 8 | 23.8 (2.03M) | 29.1 (2.37M) | 11.4 (20 px) |
| 20 | 29.9 (2.86M) | 26.7 (2.20M) | 11.0 (21 px) |
| 50 | 20.0 (2.05M) | 9.1 (0.76M) | 6.9 (9.6 px) |
| 120 | 13.3 (0.90M) | 7.9 (0.69M) | 6.4 (3.5 px) |
| 300 | 5.2 (0.25M) | 7.9 (0.69M) | 6.2 (1.3 px) |

Against plain three.js drawing of the full meshes (one `InstancedMesh` per type, the cheapest plain path):

| Scene | Full meshes | DAG 1 px | Discrete LODs 1 px |
|---|---|---|---|
| 6 props, 11.4M triangles, camera at 8 m | 37.3 ms | 9.1 ms (558k) | 10.4 ms (713k) |
| 24 props, 45.6M triangles, camera at 8 m | 105 ms | 18.7 ms (1.47M) | 28.7 ms (2.76M) |
| 24 props, camera at 50 m | 136 ms | 11.0 ms (0.90M) | 8.6 ms (0.62M) |

On the RTX 5090 the same 24 props at full density take 20 to 24 ms, and both LOD methods sit at the 5 to 8 ms measurement floor.

Along the scripted 300-frame flight with 96 props (integrated GPU):

| Mode | Frame ms, median / p95 | Triangles, min to max | Largest change in one frame |
|---|---|---|---|
| DAG 1 px | 24.0 / 35.8 | 1.70M to 4.91M | 209k |
| DAG 2 px | 18.3 / 29.1 | 0.88M to 3.31M | 141k |
| Discrete LODs 1 px | 35.8 / 56.5 | 0.69M to 6.77M | 2.44M |
| DAG budget 300k | 10.8 / 17.2 | 300.0k to 300.9k | 803 |
| DAG budget 1M | 15.7 / 23.5 | 1.000M to 1.001M | 868 |

Selection on the CPU: 0.4 to 1.2 ms median, 3.6 ms worst frame.

### Where the time goes (integrated GPU)

- **About 8 ms per million drawn triangles** with the PBR material at 1080p (for example 2.03M triangles in 20.9 ms, 1.0M in 11.7 ms, floor 3.3 ms). The full-density mesh costs only about 3 ms per million because most of its triangles are smaller than a pixel and are rejected before shading.
- **Vertex order matters a lot.** Before coarse-first vertex ordering, the same 2.03M triangles took 33.8 ms; after, 20.9 ms. The discrete-LOD baseline went from 44.6 to 26.5 ms when given its own compact vertex blocks. Any LOD scheme that indexes sparsely into the original 1M-vertex buffer is slow on this GPU.
- **Shading is roughly a third.** With an unlit untextured material the 2.03M-triangle view takes 13.5 ms instead of 20.9 ms.
- **Draw submission is not the bottleneck on Vulkan.** 17,000 ranges in three multi-draw calls cost about the same per triangle as 46 instanced draws.
- On the RTX 5090 with D3D11, cost does seem to follow the number of ranges: 81k ranges took 24.7 ms where the discrete LODs drew a similar triangle count in 7.4 ms. That is roughly 0.2 ms per thousand clusters. This is inferred from a few rows, not isolated.
- Turning per-cluster frustum culling off raised drawn triangles by 9 to 29% in the two views tested.

### Budget mode

Implemented as a priority queue over (instance, group) pairs across the whole scene. It starts from every prop's coarsest cut and repeatedly refines the group with the largest projected error until the budget is spent. Because groups are refined in strictly decreasing error order, the result is the same as finding the one threshold that hits the budget, so the cut stays crack-free. The error slider acts as a floor: refinement stops early if everything is already below it.

Measured behaviour:

- It holds the target very tightly: 300,000 to 300,900 for a 300k budget over the whole flight, and it overshoots by at most one group.
- Cost does not grow with scene size. 1,536 props (2.9 billion source triangles) with a 500k budget: 8 to 15 ms per frame, 0.6 to 0.7 ms selection. In threshold mode the same scene draws 4M to 12M triangles and takes 29 to 83 ms.
- Quality is whatever the budget allows. The effective error in the 96-prop scene ranged from 1.3 px (far) to 32 px (many props close). See [budget_300k_at_8px.jpg](images/budget_300k_at_8px.jpg) (acceptable) and [budget_300k_at_11px.jpg](images/budget_300k_at_11px.jpg) (hoists collapse to blobs, barriers crumple, textures smear). In both, the threshold cut is on the left and the budget cut on the right.

How this differs from Nanite: Nanite picks detail from pixel error and lets triangle count float, then relies on a software rasteriser, occlusion culling and streaming to afford it. A fixed budget inverts that: cost is constant and quality floats. When the camera moves, the single global threshold moves with it, so every prop on screen can change detail at once, including ones the camera did not approach. I expect that to read as shimmer in motion; I checked stills and per-frame numbers, not perception in motion.

### WebGL2 versus WebGPURenderer

- **Measured:** the same `ClodBatch` runs unchanged under three.js `WebGPURenderer` (with `_multiDrawBytesPerElement = 4`, which the class now sets itself). On the RTX 5090, 2.03M triangles in 17,000 ranges took 7.5 ms against 5.7 ms in WebGL2. The two use different ways of waiting for the GPU, so read that as "same ballpark, not faster". The JS side of `render()` was 0.7 ms.
- **Read from source (three r186):** the WebGPU backend has no multi-draw. It loops `drawIndexed` once per range in JS. WebGPU core has no multi-draw-indirect.
- **Not measured:** WebGPU on the integrated GPU. `powerPreference: 'low-power'` still returned the NVIDIA adapter, and forcing low power with a Chrome flag made three fall back to WebGL2.
- **Reasoned:** the version of this that would really use WebGPU is compute-shader culling plus indirect draws with vertex pulling from storage buffers. `three-virtual-geometry` shows this can keep three's node materials (see `RESEARCH.md`; not run here). It would remove CPU selection (about 1 ms) and draw submission, neither of which is the bottleneck here. The limit is triangle rasterisation and shading on the integrated GPU, which WebGPU does not change.

The realistic path is WebGL2 with `WEBGL_multi_draw`. A software rasteriser for tiny triangles was not attempted and is not justified by these results.

## Artefacts

| Artefact | Finding | Basis |
|---|---|---|
| Cracks | None. 35 cuts per prop (7 camera positions, 5 thresholds, up to 5 DAG levels mixed in one cut) have no open edges beyond the source mesh's own, and no error-monotonicity violations. Checked on crate, generator, hoist and the 60k crate. | Measured, `three-nanite verify` |
| Popping | No geomorphing; clusters swap instantly. At 1 to 2 px I could not see swaps in captured frames. Threshold mode changes at most 141k to 209k triangles per frame against 2.4M for discrete LODs. | Stills and numbers only |
| Texture seams | UVs survive and seams hold while edge collapse is in use. Once the vertex-clustering fallback kicks in (from level 5 on the generator), triangles span UV charts and the texture smears. Visible from roughly 8 to 10 px effective error. | Observed in captures |
| Shape at the top of the hierarchy | Thin parts (hoist arms, chains, frames) merge into blobs. Fallback levels also contain folded geometry: up to 608 edges shared by more than two triangles in one cut. | Observed and measured |
| Shading | Normals are the source normals and normal maps carry most surface detail. Full mesh, 1 px and 8 px looked the same in a medium close-up of the generator (1.87M, 225k and 98k triangles). | Observed |

## What does not work

- **Memory and download.** 67 MB per prop when fully loaded. Two props run on the integrated GPU; three and four lost the WebGL context during the first benchmark frames (measured; I did not isolate whether buffers or textures tip it over). The streaming added later loads whole levels per prop, so one close-up still pulls in tens of megabytes; levels the current cut no longer uses are released when the camera pulls back, but the granularity is a whole level, not a cluster group.
- **Skinned meshes.** Not supported. Skin weights would have to go through the simplifier and cluster bounds would have to follow bones. Not attempted.
- **Transparency.** Not supported. Clusters are drawn in selection order with no back-to-front sorting. Alpha-tested materials should work but were not tried.
- **Shadows.** Stock shadow maps do work (checked visually with a directional light). The shadow pass redraws the camera's cut, so it doubles the triangle cost and props outside the camera frustum cast no shadow.
- **Materials.** Stock three.js materials work unchanged because drawing goes through the `BatchedMesh` path (run with `MeshStandardMaterial` and `MeshBasicMaterial`). Custom shaders need the `batching` shader chunks. The preprocessor keeps only position, normal and one UV set, so a lightmap UV, vertex colours or tangents would need adding.
- **Occlusion.** Added later for whole prop instances only, from depth that is a frame or more old, with no second pass. Props coming into view appear late; not assessed in motion. Clusters inside a visible prop are not occlusion culled.
- **Collision and raycasting.** `Mesh.raycast` would see every level at once. Collision needs its own mesh, as it does today.
- **Non-uniform scale.** The error projection assumes uniform instance scale.
- **Reliance on an extension.** Without `WEBGL_multi_draw` three falls back to one draw call per cluster, which would be unusable at these counts (reasoned). Firefox does not have the extension.
