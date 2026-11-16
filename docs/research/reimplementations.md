# Nanite reimplementations and close relatives: survey

Survey date: 2026-11-11. Web reading only.

## How to read the verification labels

- **READ** = the page was fetched in this session and the statement comes from it. Note that pages were fetched through a tool that returns a model-written digest of the page rather than raw bytes, so every READ item is "fetched and digested", not "byte-for-byte inspected". For the meshoptimizer `clusterlod.h` defaults and formulas I asked for verbatim code and got it; those are the most reliable items here.
- **READ (API)** = repo metadata (stars, last push, archived flag) from the GitHub REST API on 2026-11-11.
- **SNIPPET** = seen only in a search-result summary; the page itself was not fetched. Treat as NOT VERIFIED.
- **NOT VERIFIED** = could not fetch, or not stated by the source.
- **INFERENCE** = my own conclusion drawn from the sources; not something a source says.
- **from memory, unverified** = not from any page read in this session.

Every claim carries the URL it came from. URLs that failed are listed at the end.

---

## 1. meshoptimizer `clusterlod.h` and `demo/nanite.cpp` (zeux)

### Links
- https://raw.githubusercontent.com/zeux/meshoptimizer/master/demo/clusterlod.h
- https://raw.githubusercontent.com/zeux/meshoptimizer/master/demo/nanite.cpp
- https://raw.githubusercontent.com/zeux/meshoptimizer/master/README.md
- https://github.com/zeux/meshoptimizer/releases
- https://meshoptimizer.org/v1.html
- https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/
- https://github.com/zeux/meshoptimizer/discussions/750 (JMS55 / zeux / Scthe, "Nanite-style DAG clusterizing and simplification")

### What it implements
`clusterlod.h` is a single-header build-side library: it produces the cluster DAG only. No renderer. (READ, clusterlod.h header comment: a "small 'library'/example built on top of meshoptimizer to generate cluster LOD hierarchies"; cites Karis, "Nanite: A Deep Dive", 2021; MIT, copyright 2016-2026.)

Pipeline in `clodBuild` (READ, clusterlod.h):
1. Position-only remap (`meshopt_generatePositionRemap`) so vertices split by attribute seams still count as connected. If `attribute_protect_mask` is set, vertices whose protected attributes differ from their positional twin get `meshopt_SimplifyVertex_Protect` (a seam-preserving flag, not a hard lock).
2. Initial clusters: `meshopt_buildMeshletsFlex` (default) or `meshopt_buildMeshletsSpatial` (`cluster_spatial`, used by the RT config). Optional `meshopt_optimizeMeshletLevel`.
3. Loop while more than one cluster remains:
   - Group with `meshopt_partitionClusters` (target `partition_size`, optionally spatial using cluster positions).
   - `lockBoundary`: lock every vertex shared by two or more groups, applied consistently to all vertices at the same position; user locks are OR-ed in.
   - Per group: merge triangles, target `floor(tris * simplify_ratio) * 3` indices, simplify, test for "stuck", compute monotonic error, emit the group through a callback, then re-clusterise the simplified triangles. New clusters inherit the group's merged bounds and record the emitted group id in `refined`.
4. The last remaining cluster is emitted as a terminal group with `error = FLT_MAX`.

Simplification call (READ, clusterlod.h): `meshopt_simplifyWithAttributes` with `meshopt_SimplifySparse | meshopt_SimplifyErrorAbsolute`, target error `FLT_MAX`, plus optional `meshopt_SimplifyErrorClamped`, `meshopt_SimplifyPermissive`, `meshopt_SimplifyRegularize`, `meshopt_SimplifyPreserveFolds`. Fallback chain when the target is not reached: (a) rerun with Permissive if `simplify_fallback_permissive` and permissive was not already on; (b) `meshopt_simplifySloppy` on a de-indexed copy of the group if `simplify_fallback_sloppy`, with the resulting error multiplied by `simplify_error_factor_sloppy`. If simplification returns nothing, the first triangle is kept so no empty cluster breaks the DAG.

Defaults, verbatim from `clodDefaultConfig(max_triangles)` (READ, clusterlod.h): `max_vertices = max_triangles`, `min_triangles = max_triangles / 3`, `partition_spatial = true`, `partition_size = 16`, `cluster_spatial = false`, `cluster_split_factor = 2.0f`, `optimize_clusters = true`, `optimize_clusters_level = 1`, `simplify_ratio = 0.5f`, `simplify_threshold = 0.85f`, `simplify_error_merge_previous = 1.0f`, `simplify_error_factor_sloppy = 2.0f`, `simplify_error_clamped = true`, `simplify_permissive = true`, `simplify_fallback_permissive = false`, `simplify_fallback_sloppy = true`. Asserts `4 <= max_triangles <= 256`. The comment on partition size says it is a target, and actual partitions may be up to a third larger (SNIPPET of the same file, plus digest).

Error and monotonicity, verbatim (READ, clusterlod.h):
- `bounds.error = std::max(bounds.error * config.simplify_error_merge_previous, error) + error * config.simplify_error_merge_additive;` where the right-hand `bounds.error` is the max of the children's errors.
- Merged bounds are a conservative sphere over the children's spheres (`meshopt_computeSphereBounds`); the code notes that tight bounds of the simplified mesh must not be used because that can break monotonicity.
- Stuck test: `if (simplified.size() > merged.size() * config.simplify_threshold)` then the group is emitted as terminal with `bounds.error = FLT_MAX` and its clusters are never simplified further.

Runtime rule documented in the header (READ, clusterlod.h, verbatim comment): projected error is `bounds.error / max(distance(bounds.center, camera_position) - bounds.radius, camera_znear) * (camera_proj * 0.5f)`, result in 0..1 of screen height; perspective distortion is ignored.

`clodBuildHierarchy` (READ, clusterlod.h; added in v1.2 per releases page): builds a BVH-style forest, one tree per DAG level, leaves are groups, fan-out `node_width`, grouped with `meshopt_spatialClusterPoints`.

`demo/nanite.cpp` (READ): now only a driver and metrics tool for `clusterlod.h`. Uses `clodDefaultConfig(128)`, attribute weights `{0.5, 0.5, 0.5}`, `attribute_protect_mask = (1 << 3) | (1 << 4)` to protect UV seams, error threshold `2e-3f` commented as "2 pixels at 1080p", BVH `node_width = 8`. It counts triangles in the cut via hierarchy traversal: prune a node when its projected error is `<= threshold`; keep a cluster if it has no refined parent or its parent group's error is `<= threshold`... (the digest describes the keep test loosely; read the file before copying the condition). The strings "METIS"/"metis" do not appear in the current file. Prints per-level stats including stuck cluster counts.

Related API status from release notes (READ, https://github.com/zeux/meshoptimizer/releases; the page shows day and month only, the years below are INFERENCE from version order and the zeux post date):
- v0.23 (Mar, 2025): `meshopt_buildMeshletsFlex`, experimental `meshopt_partitionClusters`, `meshopt_computeSphereBounds`.
- v0.24 (Jun, 2025): `meshopt_buildMeshletsSpatial` (SAH, for ray tracing); `partitionClusters` accepts positions for spatial locality; `meshopt_simplifyPrune`.
- v0.25 (Aug, 2025): `meshopt_simplifyWithUpdate`, `meshopt_SimplifyPermissive`, `meshopt_SimplifyRegularize`, sloppy simplifier gains vertex locks.
- v1.0 (Dec, 2025): `clusterlod.h` introduced ("similarly to Nanite"); `partitionClusters` handles disconnected clusters better; Permissive still experimental.
- v1.1 (Apr, 2026): meshlet codec (compresses meshlet topology); `optimize_clusters_level` in `clodConfig`.
- v1.2 (Jun, 2026): `clodBuildHierarchy`; meshlet codec stable; `partitionClusters` about 2x faster in some configurations.
- v1.3 (Sep, 2026): "`meshopt_SimplifyPermissive` ... is now stable"; `simplify_dilate_borders`; clamped errors on by default; experimental `SimplifyPreserveFolds`, `SimplifyErrorClamped`.
- `meshopt_SimplifySparse` and `meshopt_SimplifyErrorAbsolute` date from v0.21 (READ, same page).

README (READ): lists `clusterlod.h` as a companion "single-header C/C++ library for continuous level of detail using clustered simplification"; describes `meshopt_partitionClusters` as usable "for hierarchical simplification schemes similar to Nanite"; notes that with hierarchical cluster LOD all clusters at all levels must share the position quantisation exponent; `meshopt_SimplifySparse` is intended for meshlet-sized subsets of a large vertex buffer; meshlet codec encodes each meshlet independently; recommends `meshopt_setAllocatorCache` for `clusterlod.h` workloads. meshoptimizer.org/v1.html (READ) says `clusterlod.h` is kept outside the stable API because the area is "quickly evolving", and that data generation "at best, is half of the story".

### What it skips
- All runtime: no culling, no rasterisation, no streaming, no page format (READ, v1.html and clusterlod.h).
- No METIS dependency at all (READ, nanite.cpp, clusterlod.h).

### Numbers
From zeux's post on building NVIDIA's Zorah scene (READ, https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/):
- Scene: 36.1 GB glTF, "1.64B triangles, 18.9B triangles with instancing".
- Hardware: Ryzen 7950X (16C/32T), 192 GB RAM.
- Build time, 16 threads: about 9 min 20 s baseline, down to about 2 min 35 s after fixes (sparse-subset memset fix, sorting meshes by size, SIMD, `meshopt_spatialSortTriangles`, per-thread allocator cache). Peak memory about 45-60 GB.
- NVIDIA's own sample at 7 threads: about 30 minutes.
- Rendering the result in `vk_lod_clusters` on a GeForce 3050: about 2 GB geometry pool, 16 ms raster / 26 ms ray traced.
- Pitfall found there: `partitionClusters` only grouped topologically adjacent clusters, producing too many DAG roots; fixed shortly after (and listed in v1.0 notes).

From discussion #750 (READ): zeux says 64v/64t meshlets will "never" be fully balanced; `meshopt_computeClusterBounds` is for single meshlets, and the error function is not monotonic unless the merged group's bounds contain the children's bounds; JMS55 measured meshlet fill on a cliff mesh dropping from 99.6% full at LOD 0 to 15.7% at LOD 5 with the older approach; zeux states the goal that METIS becomes "unnecessary in Nanite like pipelines".

### Platform needs
C/C++ header on top of `meshoptimizer.h`. No GPU. Whether the shipped JS/WASM modules of meshoptimizer expose `partitionClusters` / `buildMeshletsFlex` was not checked in this session (from memory, unverified: the repo ships `js/meshopt_simplifier` and `js/meshopt_clusterizer` modules). Scthe compiled meshoptimizer and METIS to WASM himself with Emscripten (READ, https://github.com/Scthe/nanite-webgpu).

### Lessons for a three.js implementation
- This is the reference build algorithm to port or compile to WASM. It encodes fixes for the three classic failures: cracks (position-consistent group-boundary locks), stuck simplification (permissive mode, sloppy fallback with inflated error, terminal groups at `FLT_MAX`), and non-monotonic error (max with children, bounds merged from children).
- The whole-DAG cut rule needs only two numbers per cluster (own group error + bounds, refined/parent group error + bounds); that is cheap to evaluate on CPU or in a compute shader.
- Protect UV seams rather than lock them, otherwise faceted or seam-heavy meshes stall.
- All levels must share one position quantisation grid if positions are quantised (README).

### Verification status
READ for all source files, release notes, README, v1.html, the blog post and discussion #750. Release years are INFERENCE. The exact leaf "keep" condition in `nanite.cpp` should be re-read from source before copying.

---

## 2. Bevy "virtual geometry" (meshlet feature, `bevy_pbr::meshlet`)

### Links
- https://jms55.github.io/posts/2024-06-09-virtual-geometry-bevy-0-14/
- https://jms55.github.io/posts/2024-11-14-virtual-geometry-bevy-0-15/
- https://jms55.github.io/posts/2025-03-27-virtual-geometry-bevy-0-16/
- https://jms55.github.io/posts/2024-08-30-bevy-fourth-birthday/ and https://jms55.github.io/posts/2025-09-03-bevy-fifth-birthday/
- https://bevy.org/news/bevy-0-14/ , https://bevy.org/news/bevy-0-15/ , https://bevy.org/news/bevy-0-16/ , https://bevy.org/news/bevy-0-17/
- https://github.com/bevyengine/bevy/pull/19318 (BVH culling)
- https://raw.githubusercontent.com/bevyengine/bevy/main/crates/bevy_pbr/src/meshlet/from_mesh.rs
- https://raw.githubusercontent.com/bevyengine/bevy/main/crates/bevy_pbr/src/meshlet/mod.rs
- https://docs.rs/bevy/latest/bevy/pbr/experimental/meshlet/struct.MeshletPlugin.html (docs for bevy 0.20.1)
- https://github.com/bevyengine/bevy/issues/11518 (tracking issue), https://github.com/bevyengine/bevy/discussions/14998
- https://news.ycombinator.com/item?id=42974461 (jms55 comment on WebGPU)

### What it implements

Build (current `main`, READ from_mesh.rs):
- Input must be an indexed triangle list with exactly POSITION, NORMAL, UV_0.
- LOD 0 clusters: triangle adjacency graph partitioned with METIS (`part_recursive`, seed 17, `UFactor` 1, `triangle_count.div_ceil(126)` parts), then `build_meshlets(..., 256, 128, 0.0)` per partition, i.e. up to 256 vertices / 128 triangles.
- Grouping: METIS on a meshlet graph weighted by shared vertices, `TARGET_MESHLETS_PER_GROUP = 8`.
- Locks: any position-unique vertex touched by more than one group.
- Simplify: `simplify_with_attributes_and_locks`, target half the indices, `target_error = f32::MAX`, normal weights `[0.5; 3]`, `Sparse | ErrorAbsolute`.
- Group rejected if it has one meshlet or the result exceeds `SIMPLIFICATION_FAILURE_PERCENTAGE = 0.60` of the input; rejected groups go to a `stuck` list, are retried while enough triangles are still passing, and finally form one last LOD level.
- Group error is raised to at least the max error of its member meshlets; new meshlets inherit the group's LOD sphere and error.
- A BVH8 per mesh is built over groups (SAH-sorted), with a `verify_bvh` step that asserts error monotonicity and reachability of every meshlet.
- Per-meshlet vertex data: positions quantised (default factor 4, in centimetres) and bit-packed with per-meshlet offsets; normals octahedral in 2x16 snorm; UVs uncompressed.
- Doc comment warns the conversion is very slow and should be done ahead of time; cracks between separate meshes are only avoided under strict conditions on quantisation, translation, scale and rotation.

Runtime history:
- 0.14 (READ, 0.14 post): per-frame "fill cluster buffers" compute pass; culling pass 1 (frustum + LOD cut + occlusion against the previous frame's depth pyramid); hardware raster of visible clusters with one indirect draw into a visibility buffer (R32Uint) plus material depth (R16Uint); depth pyramid build (ported FidelityFX SPD); culling pass 2 for clusters that failed occlusion; second raster; one full-screen triangle per material with depth-equal test, attributes reconstructed with manually computed barycentrics and derivatives. Initially groups of 4 and 64/64 meshlets, and the post describes a "tree of clusters" that for most meshes could not reach a single root.
- 0.15 (READ, 0.15 post): software rasteriser in compute for clusters whose screen AABB is under 64 px on both axes, hardware raster for the rest and for anything crossing the near plane; both write a 64-bit visbuffer with `atomicMax` (depth in the high 32 bits, cluster and triangle ids in the low 32: 25 + 7 bits); meshlets grew to 255 vertices / 128 triangles; grouping target 8; only group-border vertices locked; normal-aware simplification; LOD spheres now enclose children and the projection function was "adapted from" zeux's `nanite.cpp`; per-meshlet compressed vertex data; screen-space-derived tangents.
- 0.16 (READ, 0.16 post): METIS-based triangle clustering replaces plain `meshopt_buildMeshlets` for LOD 0 to reduce shared vertices and tiny unsimplifiable meshlets; visbuffer moved from a buffer to an R64Uint storage texture using texture atomics.
- 0.17 (READ, bevy-0-17 news; PR #19318): BVH-based culling by SparkyPotato and atlv24. PR text also lists fixes to near-plane over-culling, HZB sampling and the orthographic error metric. The PR page itself gives no pass-level description.
- Current `mod.rs` (READ): systems `meshlet_visibility_buffer_raster`, `meshlet_prepass`, `meshlet_deferred_gbuffer_prepass`, `meshlet_main_opaque_pass`.

How the lack of 64-bit atomics was handled: it was not worked around; software raster was simply blocked until wgpu exposed 64-bit atomics natively (0.14 post: blocked "on 64-bit texture atomics"; 0.15 post: arrived via 64-bit integer / atomic support in wgpu 22; 0.16: R64Uint texture atomics). (READ)

### What it skips
- Streaming: not implemented (0.15 post; 0.17 news says asset VRAM is a practical limit because streaming "isn't implemented yet"; tracking issue #11518 still lists streaming, triangle compression, disk compression, single pass for all views). (READ)
- Fixed-point rasterisation and top-left fill rule in the software rasteriser were skipped (0.15 post). (READ)
- UV-aware error: positions and normals only, weights "completely arbitrary" (0.15 post). (READ)
- No mesh shaders (wgpu lacked them, 0.14 post). (READ)
- MSAA unsupported; cannot mix forward+prepass and deferred for opaque; material restrictions (MeshletPlugin docs 0.20.1). (READ)
- Still experimental; JMS55 moved to the Solari ray tracing work and cites burnout (fifth-birthday post). (READ)
- Changes in 0.18 to 0.20 specific to meshlets: NOT VERIFIED (search found nothing; the 0.20.1 docs still describe the same limits).

### Numbers
- 0.14 (READ): 3,092 Stanford bunny instances (144,042 tris each), RTX 3080 at base clock, 2240x1260: about 2.78 ms for the visbuffer passes (cull 1 0.49 ms, raster 1 1.85 ms).
- 0.15 vs 0.14 (READ): 3,375 bunnies, same GPU and resolution: 4.97 ms to 0.93 ms total; hardware raster 3.44 ms replaced by software raster 0.42 ms. Cliff scene (847 instances): 2.32 ms, first culling pass 1.27 ms is "the clear bottleneck". Bunny DAG went from 7 levels to 12; worst-case meshlet fill from about 20% to 76%. Compressed vertex data cut memory on a test mesh from 110 MB to 64 MB. Overflow pitfall: at 1,042 cliff instances the scene exceeded 2^25 clusters and glitched.
- 0.16 (READ): texture atomics about 0.42 ms faster in a simple scene; a `discard` for background pixels doubled resolve-pass speed; `clear_texture` fallback cost 0.68 ms versus about 0.01 ms.
- 0.17 (READ, bevy-0-17 news): 130,000 dragons (about 870k tris each, over 115 billion triangles) in about 3.5 ms on an RTX 4070 (3.1 ms geometry, 0.4 ms materials); over 1 million instances (about 900 billion triangles) about 4.5 ms; 1,300-instance scene 2.2 ms (0.16) to 1.3 ms (0.17). The news digest says the old cap was 2^24 clusters while the 0.15 post and current docs say 2^25; discrepancy not resolved.

### Platform needs
- Docs for 0.20.1 (READ): requires `WgpuFeatures::TEXTURE_INT64_ATOMIC`; "currently works only on the Vulkan and Metal backends". `mod.rs` on `main` lists required features `TEXTURE_INT64_ATOMIC`, `TEXTURE_ATOMIC`, `SHADER_INT64`, `SUBGROUP`, `DEPTH_CLIP_CONTROL`, `IMMEDIATES`, and exits if any is missing.
- WebGPU in browsers: not supported. jms55 on HN (READ, Feb 2025): the feature "makes use of 64-bit integers and atomics, which are not supported on WebGPU at the moment", so "I can't do a web demo yet". DX12 is not listed as supported in the docs.

### Lessons for a three.js implementation
- The Bevy visbuffer and software raster design is not portable to browser WebGPU as-is: it depends on 64-bit atomics. A browser version needs either hardware raster only (see section 4, three-virtual-geometry) or a 32-bit packed target (see section 3).
- Advice from the author: skip software raster until late, and prefer mesh shaders if available (0.15 post). Browsers have neither mesh shaders nor 64-bit atomics, so hardware raster via indirect draws is the practical first target (INFERENCE).
- A flat per-cluster culling dispatch was the bottleneck until BVH culling landed; plan a hierarchy over groups if instance counts are large.
- DAG quality came mostly from the build: bigger meshlets (128 tris), groups of 8, locking only true group borders, position-only connectivity, and error = max(own, children). Early versions that got these wrong could not reach a single root.
- Use one quantisation grid across meshlets, or cracks appear.
- Occlusion with a previous-frame depth pyramid has edge cases (non-power-of-two mips, `ceil` versus `floor` when choosing the mip) that caused culling bugs.

### Verification status
READ for the three JMS55 posts, both birthday posts, release news 0.14 to 0.17, PR #19318 page, `from_mesh.rs`, `mod.rs`, docs.rs 0.20.1, issue #11518, discussion #14998, HN thread. Internals of the BVH culling passes: NOT VERIFIED (PR page gives no description; shaders not read). 0.18+ changes: NOT VERIFIED.

---

## 3. Scthe/nanite-webgpu

### Links
- https://github.com/Scthe/nanite-webgpu and https://raw.githubusercontent.com/Scthe/nanite-webgpu/master/README.md
- https://github.com/Scthe/nanite-simplification-tests
- https://github.com/bevyengine/bevy/discussions/14998 (started by Scthe)
- Repo metadata (READ, API): 1,130 stars, MIT, created 2024-07-15, last push 2026-05-09.

### What it implements (READ, README)
- Meshlet LOD hierarchy built in the browser with WASM builds of meshoptimizer and METIS; binary export to skip preprocessing; OBJ input; textures and per-vertex normals.
- GPU-driven path: per-instance and per-meshlet frustum and occlusion culling in compute; "For meshlet culling and LOD selection, I dispatch thread per-meshlet" (flat, no hierarchy traversal). A CPU path exists for comparison.
- Occlusion uses the previous frame's depth pyramid, single pass, no reprojection.
- Software rasteriser in compute for small meshlets. Because WGSL has no `atomic<u64>`, it packs depth as u16 plus an octahedral normal as 2 x u8 into one 32-bit atomic value. Output is therefore untextured shading only.
- Billboard impostors: 12 views around the up axis, dither-blended, storing diffuse and normals; used for distant instances.
- Optional vertex position quantisation (off by default). Debug views, stats, profiler button, "freeze culling".
- Shader unit tests run offline in Deno.

### What it skips (READ, README)
- "No visibility buffer. It's not possible with the `atomic<u64>` limitation".
- No two-pass occlusion culling (kept out for readability).
- Backface cone culling was implemented then removed: small gain, and its per-meshlet WASM call took about 30% of preprocessing time.
- No streaming or eviction, no compression, no instance BVH, no shader work queue, no shadows or multi-view.
- Error metric is plain projected simplification error from meshoptimizer; the author calls it "not a great metric for Nanite" and says other attributes should contribute.
- The author kept an older meshoptimizer and did not adopt `meshopt_SimplifySparse`; he states he is "moving on from this app".

### Numbers (READ, README)
- Demo scenes: Jinx 120 x 120 instances = 640M triangles; Lucy + dragons 70 x 70 each = 1.7B, where "Nearly 98% of the triangles are software rasterized"; Lucy 110 x 110 = 1.2B; dragons 70 x 70 = 1.2B; bunnies 500 x 500 = 1.2B.
- DAG results: Jinx 44k triangles only reaches 3k (59 root meshlets); Lucy 100k to 86 (single root); dragon 250k to 102; bunny 5k to 96. A 910k mecha model stalled at 180k after 5 levels.
- No absolute FPS, frame times or GPU model in the README; only that disabling one optimisation "tanks" FPS by 40%.
- Per-instance memory: `instanceCount * bottomLevelMeshletsCount * sizeof(vec2u)`; the author says this does not scale to many distinct objects.
- Stuck handling: stop simplifying a level when fewer than about 6% of triangles are removed (`simplificationFactorRequirement` 0.94; with 0.97 the bunny reaches a single 116-triangle root).

### Platform needs (READ, README)
- "WebGPU is only available on Chrome!" (as written when the README was authored). Also runs in Deno.
- Chrome's 128 MB storage-buffer limit shaped scene sizes ("can be raised if needed").
- "WebGPU does not have early-z" (author's statement).

### Lessons relevant to three.js (READ unless marked)
- The honest limits list is the main value: in browser WebGPU a software rasteriser can only do a 32-bit depth+payload atomic, which gives z-fighting and leaks at 16-bit depth and no material ids.
- "Simplification is the hard part"; culling and meshlet plumbing take more effort than the Nanite-specific parts; start from a GPU-driven pipeline and add the DAG later.
- The DAG aims for roughly one pixel per triangle, not minimal triangles for far objects, hence impostors for the far field.
- From the simplification tests repo: faceted meshes (unique vertex per position+normal) cannot be collapsed; the only always-working fix he found was randomly removing triangles when stuck and raising the reported error. METIS sometimes yields single-meshlet groups.
- In discussion #14998 his data showed both his and Bevy's early builds leaving too many root meshlets (Jinx: 59 vs 120 roots); zeux's reply: when stuck, merge more meshlets per step, and weld aggressively for faceted input.
- A flat per-meshlet dispatch is workable for demo-scale scenes of one or two unique meshes (INFERENCE from his scaling note).

### Verification status
READ: repo page, raw README, simplification-tests README, discussion #14998. Shader sources not read; the exact software/hardware split heuristic is NOT VERIFIED (a `softwarerasterizer_threshold` URL parameter exists but its logic is not described in the README).

---

## 4. three.js projects

### 4a. three-virtual-geometry (elad12390)

Links: https://github.com/elad12390/three-virtual-geometry , https://cdn.jsdelivr.net/npm/three-virtual-geometry@0.1.3/README.md , https://elad12390.github.io/three-virtual-geometry/ , https://elad12390.github.io/three-virtual-geometry/guide/how-it-works , https://elad12390.github.io/three-virtual-geometry/guide/performance

Status (READ, API): created 2026-10-08, last push 2026-10-10, 2 stars, 16 commits, npm version 0.1.3. Very new and unreviewed by the community; all performance figures are the author's own.

What it implements (READ, README and how-it-works page):
- Build: meshoptimizer `buildMeshlets` up to 128 triangles; meshlets sharing boundary edges grouped about 12 at a time by a greedy region-growing partition (no METIS); each group merged and simplified to half with the outer border locked; re-split; repeat. Each meshlet stores its error and its parent's error; errors grow toward the root. Builds are cached in the browser or baked to `.vgeo` with a CLI.
- Stuck handling for foliage: a voxel proxy (voxelise, close gaps, extract surface, simplify) replaces coarse levels when it has lower measured error; a separate path for disconnected "leaf cards".
- Runtime in WebGPU compute: a pool-wide set of passes (the docs say 12 passes; five stages are named: Cells, Instances, Meshlets, Prefix, Expand). Instances are grouped into Morton-sorted cells of 128 for coarse culling. Cut rule: draw when `projectedError(meshlet) <= threshold < projectedError(parent)`, threshold about one pixel.
- Drawing: selected meshlets are expanded into a shared index buffer (index encodes `drawSlot * 128 + localVertex`), and each mesh is a normal three.js `Mesh` drawn with one indexed indirect draw; the material's `positionNode` fetches vertex data from storage buffers, so standard NodeMaterials, lights, shadows, fog and tone mapping keep working.
- Occlusion: last frame's selected solid meshes are redrawn depth-only from the current camera into a small depth target, reduced to a depth hierarchy; an `occlusion.auto` mode measures frames with it on and off and keeps the faster.
- LOD cross-fade: per-pixel dithered threshold band, intended to average out under TAA.
- A GPU "capacity controller" coarsens the threshold if fixed-size draw buffers would overflow, with no CPU readback.
- Shadows use a second, coarser selection.

What it skips (READ): "Hardware rasterization only (no software rasterizer for pixel-sized triangles)"; no visibility buffer; no streaming described; static meshes only (instances can move); one UV channel; occlusion needs a perspective camera with standard depth.

Numbers (READ, performance page; author-reported, Apple M4 Pro 24 GB, Chrome 154, uncapped, 1 px threshold, shadows on except stress test): Ruins 5.7B source triangles / 113k instances: 160-230 FPS at 1080p, 103-158 at 4K, 6.5-9.0M triangles drawn per frame. World 37.5B / 3.0M instances: 147-150 FPS at 1080p. Stress 1M instances (39.5B): 177-1,404 FPS at 1080p. Claimed CPU cost at most 0.6 ms per frame. No memory or bake-time figures.

Platform needs (READ): three.js r180+, `THREE.WebGPURenderer`, a WebGPU browser (README lists Chrome/Edge 113+, Safari 26+, Firefox 141+ on Windows). Pools are capped by the 128 MB storage-buffer binding size; a new pool is opened when one fills.

Credits (READ): "based on public descriptions of the technique and the MIT-licensed nanite-webgpu"; built on meshoptimizer.

Lessons: this is the only project found that shows the complete loop inside three.js itself (compute culling, index expansion, indexed indirect draw, vertex pulling through TSL `positionNode`), and it does so without a visbuffer or software raster. It demonstrates that hardware raster with a roughly 1 px threshold draws 6-9M triangles per frame, which an M4 Pro GPU tolerates; weaker GPUs are untested (INFERENCE from the single-machine benchmark).

Verification: READ for README, repo page, docs home, how-it-works, performance. Source code not read; claims not independently reproduced.

### 4b. AIFanatic/three-nanite

Links: https://github.com/AIFanatic/three-nanite , https://raw.githubusercontent.com/AIFanatic/three-nanite/master/README.md , demo https://aifanatic.github.io/three-nanite/dist/index.html , HN thread https://news.ycombinator.com/item?id=42974461

Status (READ, API): 490 stars, MIT, created 2022-11-21, last push 2024-09-02. README: "The code is a mess at the moment" and "Very far from it but nonetheless a start".

What it does (READ, README): METIS to cluster triangles into meshlets, METIS to group adjacent meshlets, meshoptimizer to merge (sharing vertices) and simplify to about half (capped at 128 triangles), then split again. Demonstrates the cut principle: "as long as the edges of the DAG don't cross there should be no cracks". TODO: more testing of LODs and DAG cut; stream geometry to GPU.

What it skips: the README describes only the continuous LOD build and cut; nothing on GPU culling, visbuffer, software raster or streaming. How rendering is done (WebGL vs WebGPU, CPU vs GPU cut selection) is not stated in the README: NOT VERIFIED. An HN commenter (READ) observed it reports about 700,000 triangles "even when there's nothing visible on-screen" and suggested frustum culling; another said projects like this focus on "just the continuous lod without the rest".

Numbers: one HN user reported 20 fps near and 40 fps far on a late-2010s Celeron with integrated graphics (READ, HN; anecdotal).

Lessons: a useful minimal reference for the build steps in JS; not a renderer design.

### 4c. Usnul's "Micron" / "Virtually Geometric" (three.js forum) and the Shade engine

Links: https://discourse.threejs.org/t/virtually-geometric/28420 (pages 1 and 4 read) , https://discourse.threejs.org/t/shade-webgpu-graphics/66969

- 2021-2022 (READ, page 1): closed-source virtual geometry for three.js on WebGL. Custom JS graph partitioner (he ported METIS to JS and found his own about 10x faster for this task); batched by material; emulated a geometry-shader-like expansion on WebGL to cut CPU-to-GPU traffic to about 2% of the first approach; early versions selected the cut on CPU and re-uploaded geometry each frame, which was slow. Preprocessing about 2 s for a 100k-triangle model. Demos: 10 x 10 Lucy (10M source triangles) drawing about 2-3M; a 100 x 100 grid totalling 1 billion triangles (Nov 2022). Not open source; sold to a company (Feb 2022). Pitfalls named: tiny instances waste whole clusters; thin geometry (grass, trees) simplifies badly; deep pipelines compound errors and needed many debug tools.
- 2026 (READ, page 4, posts dated Sep 2026): new WebGPU virtual geometry system. Streamable format designed for HTTP range requests (done); converter at "about 50k triangles per second" (done); renderer in progress. Tested on NVIDIA Zorah: converted assets 50.1 GB, about 2.1 GB streamed during a demo with a 1 GB RAM cache and under 512 MB VRAM, LZ4 decompression; later reports loading the full 18.9B-triangle instanced scene. Pitfalls: per-view cuts (shadows), streaming and memory dominate the runtime; keeping cluster headers as JS objects "quickly becomes untennable"; dense foliage produces large simplification error. Not open source.
- Shade (READ, first page, June 2024): closed-source WebGPU engine by the same author with GPU-driven culling and draw dispatch, conservative occlusion culling, and visibility-based deferred shading; 1,000,000 meshes (12M triangles) at 144 FPS on an RTX 4090. Meshlets are mentioned only on later pages (SNIPPET: an instance to meshlet to triangle expansion with "visible" and "maybe" sets).

### 4d. Others mentioned on the forum
- cnr-isti-vclab/nexus (https://github.com/cnr-isti-vclab/nexus): C++/JS batched multiresolution mesh library with a three.js loader, linked in the thread as the open-source ancestor of the idea (READ of the forum post only; repo not fetched: NOT VERIFIED).
- VeinSyct/ThreeJsCannon "threeverse" GLB viewer with LOD experiments (READ of forum post only; NOT VERIFIED).
- No official three.js example or core feature for cluster LOD was found (search only; absence is NOT VERIFIED). mrdoob ruled out core inclusion of Micron and suggested an external class (READ, forum page 1, Feb 2022).
- AIFanatic/trident: I checked whether it is a WebGPU successor to three-nanite. The README fetched describes a three.js + PhysX ECS engine and says nothing about meshlets or WebGPU (READ, https://github.com/AIFanatic/trident). Any link between Trident and Nanite-style rendering is from memory, unverified.

---

## 5. Unity community attempts (brief)

| Project | Link | What the source says | Status |
|---|---|---|---|
| Unity Virtual Mesh (official reference) | https://github.com/Unity-Technologies/com.unity.virtualmesh | Companion to a CEDEC 2024 talk on lightweight virtual geometry for mobile. GPU-driven, "triangle cluster LODs and two-pass occlusion culling at a triangle level", compute culling + indirect draws, partial streaming with placeholders. URP + Render Graph, Unity 6.3+, Vulkan required, DX12 and iOS "underway". Static opaque meshes only. "not production-ready and only serves as a reference". No performance numbers. | READ. 180 stars, created 2025-10-21, last push 2026-01-27 (API). |
| DELTation Virtual Mesh | https://deltation.com/blog/virtual-mesh-00 | Nanite-inspired, Unity 6 + URP + DX11, "no need for Mesh Shader support"; continuous LOD graph by error metric; GPU culling per instance / meshlet / triangle; streaming; demo scene 72M triangles. Follow-up post on occlusion culling exists. Licence not stated. | READ (post dated 2025-03-14). |
| UNanite / VGeo | https://github.com/anomal3/UNanite-Demo | HDRP/URP 17.4, Unity 6000.4, DX12. "Cluster DAG with automatic LOD, GPU culling with two-pass occlusion, visibility buffer, software raster for tiny triangles", page streaming, compressed geometry. Author-reported on RTX 3060 at 1080p: 12.9 ms vs 94 ms for stock MeshRenderers in its demo. Source included, GPL-3.0 with Unity exception. | READ. 12 stars, created 2026-09-26 (API). |
| lyz776/UnityNanite | https://github.com/lyz776/UnityNanite | Unity 6 URP research project: cluster hierarchy bake via a meshoptimizer wrapper, compressed streamable pages, frustum + HZB culling, VBuffer material resolve; hardware raster is the production mode, hybrid is experimental. Windows / D3D12. No numbers, no licence. | READ. 1 star (API). |
| ZEngineStudios "Seamless Virtual Geometry" | https://github.com/ZEngineStudios/Unity-Nanite-Seamless-Virtual-Geometry- and https://discussions.unity.com/t/free-nanite-style-virtual-geometry-for-unity-seamless-virtual-geometry/1645796 | URP; meshlet LOD hierarchy, BVH + GPU culling, hardware raster + visibility buffer; explicitly no software raster, two-phase occlusion, streaming or compression. Core ships as obfuscated DLLs; forum users raised trust concerns and reported an Asset Store takedown; broken on Unity 6.2. | READ (forum thread). 112 stars, last push 2025-05-21 (API). Treat with caution. |
| NADE demo | https://github.com/Unfinished-B/NADE-Unity-Virtual-Geometry-Engine-Demo | Teaching companion: Unity 6.2 HDRP, DX12; cluster LOD, two-pass HiZ, hardware raster into HDRP GBuffer, page streaming. Author-reported on RTX 2080 Ti (Island scene, 3,589 instances): stock 13.4 ms vs NADE 22-24 ms, i.e. slower than stock there. Includes a "How_To_Build_Nanite.md" guide recommending `meshopt_partitionClusters` over METIS for simplicity. PolyForm Noncommercial. | READ. 11 stars (API). |
| rpondicherry/VirtualGeometry | https://github.com/rpondicherry/VirtualGeometry | Unity 6 / HDRP 17.7, meshopt-based DAG build "done", streaming and mesh shaders not started. | SNIPPET only; repo returned 404 on fetch and via API. NOT VERIFIED. |
| Tencent NanoMesh (not Unity-specific; mobile) | https://advances.realtimerendering.com/s2024/content/Cao-NanoMesh/AdavanceRealtimeRendering_NanoMesh0810.pdf | SIGGRAPH 2024 talk on Nanite-like rendering for mobile; Arm reports a demo of 140M+ triangles near 120 FPS on 2023 flagship phones. | SNIPPET only. NOT VERIFIED. Scthe's README cites these slides. |

Common lesson (INFERENCE across the READ items): the Unity projects that target wide hardware (Unity's own package, DELTation, ZEngine, NADE) all use compute culling plus hardware raster through indirect draws, without mesh shaders; software raster and 64-bit visbuffers appear only in DX12-only projects. NADE's own numbers show a hardware-raster-only cluster renderer can be slower than the stock renderer on ordinary scenes.

---

## 6. Write-ups by people who built one

### 6a. jglrxavpok, "Recreating Nanite" (Carrot engine, C++/Vulkan)

Links (all READ): 
- https://jglrxavpok.github.io/2023/11/26/recreating-nanite-visibility-buffer.html
- https://jglrxavpok.github.io/2023/12/07/recreating-nanite-cluster-rendering.html
- https://jglrxavpok.github.io/2024/01/19/recreating-nanite-lod-generation.html
- https://jglrxavpok.github.io/2024/03/12/recreating-nanite-faster-lod-generation.html
- https://jglrxavpok.github.io/2024/04/02/recreating-nanite-runtime-lod-selection.html
- https://jglrxavpok.github.io/2024/05/13/recreating-nanite-mesh-shader-time.html
- https://jglrxavpok.github.io/2024/08/21/recreating-nanite-raytracing.html
- Also listed but not fetched: "The Plan" (2023-11-12), "A basic material pass" (2024-02-06). A mirror host blog.jglrxavpok.eu appeared in search (SNIPPET).
- Repo https://github.com/jglrxavpok/Carrot : 98 stars, MIT, active (push 2026-11-09) (READ, API).

What worked:
- Visibility buffer as an `R64Uint` storage image written from the fragment shader with `imageAtomicMax`, depth in the high 32 bits (inverted so max means nearest), id in the low 32.
- Clusters from `meshopt_buildMeshlets` (64 vertices / 128 triangles), each cluster owning its vertex data; first drawn with one indirect draw per cluster, later with task + mesh shaders.
- LOD build: METIS groups of 4 meshlets (edge weight = shared edges), `meshopt_simplify` with `meshopt_SimplifyLockBorder` to 50%, re-split, up to 25 levels.
- Runtime rule: draw when `clusterError <= errorThreshold && parentError > errorThreshold` at a 1 px threshold, with errors projected through bounding spheres. All meshlets of a group share one sphere and error.
- Ray tracing: one BLAS per group (not per cluster), selected by a compute pass and read back to the CPU; BLASes precomputed in the asset pipeline.

Pitfalls:
- Simplifier stuck on faceted meshes (Damaged Helmet): too few connected triangles to hit the target within the error budget. First fix was vertex welding with per-LOD k-d trees; ignoring UVs "produces this atrocity", respecting UVs left holes at coarse LODs.
- The "major flaw" in the first version: border vertices were being merged by the welding step even though borders must match exactly. Fix: detect boundary edges (edges belonging to one meshlet) and exclude their vertices from welding.
- Non-monotonic error: if a parent is barely simplified its error can be below its children's, so `parentError == selfError` and a cluster is never drawn. Fix: add the max child error to the parent's ("Not sure if that's the correct way to do it").
- Storing bounds per meshlet instead of per group gives missing or overlapping meshlets.
- Running the simplifier over the full vertex buffer was slow; remapping each group into a compact buffer first "massively reduced" build time (the same problem `meshopt_SimplifySparse` addresses).
- METIS: CMake integration problems, segfaults from mismatched index sizes.
- Mesh shaders: workgroup size 1 left the GPU idle; a CPU-visible debug counter with atomics slowed the draw badly.
- Ray tracing: per-cluster BLAS reached about 30k BLASes and over 4 GB before crashing; readback adds about 3 frames latency.

Numbers:
- Happy Buddha LOD generation on a Ryzen 7 2700X: about 4 minutes down to about 40 seconds.
- Mesh shader draw: 8.65 ms with workgroup size 1, about 0.8 ms after using 64-thread mesh and 32-thread task workgroups; Bistro at about 80 FPS, GPU-bound by lighting and denoising. GPU model not stated (NVIDIA).
- Bistro reference view: about 11k visible groups; BLAS bookkeeping 41 ms down to about 8 ms.

DAG vs tree: not discussed by this author beyond citing Traverse Research.

### 6b. LVSTRI / IrisVk

- https://github.com/LVSTRI/IrisVk : repo exists, 7 stars, 51 commits, last push 2023-11-14, no README and no description (READ, repo page and API). Folders: `deps`, `include/iris`, `shaders`, `src/iris`.
- No blog or write-up found: https://lvstri.github.io/ returns 404; two searches found nothing. JMS55's 0.14 post thanks LVSTRI for sharing experience (SNIPPET).
- A "Recreating Nanite" write-up by LVSTRI: NOT VERIFIED; I could not find one. The phrase belongs to jglrxavpok's series as far as this search shows.
- From memory, unverified: IrisVk is a Vulkan renderer with meshlet LODs, a visibility buffer and virtual shadow maps.

### 6c. Traverse Research, "Creating a Directed Acyclic Graph from a Mesh"

- https://blog.traverseresearch.nl/creating-a-directed-acyclic-graph-from-a-mesh-1329e57286e5 : HTTP 403 on both the blog host and the medium.com form; web.archive.org is not reachable from the fetch tool.
- Existence, title and that it uses METIS and meshlets: READ indirectly from jglrxavpok's LOD generation post, which links it.
- Contents: NOT VERIFIED.

### 6d. SimNanite (Shawn Tang, DX12 MiniEngine)

Links: https://shawntsh1229.github.io/2024/05/08/Simplified-Nanite-Virtualized-Geometry-In-MiniEngine , https://github.com/ShawnTSH1229/SimNanite (27 stars, last push 2024-09-29; READ, API).

READ: METIS triangle clustering (position-hashed vertices); groups of about 4-8 clusters; meshoptimizer QEM on merged clusters; DAG serialised to disk; BVH with 4 children per node, one root per LOD, built by sorting on the longest axis instead of SAH. GPU culling in three levels: instances, persistent BVH-node culling with an MPMC-style queue, then leftover cluster culling. Hardware path via indirect draws; software path one thread per triangle with `InterlockedMax` on integer depth. Visbuffer: 16 bits triangle + 16 bits instance; one full-screen quad per material using a material-id depth. Skipped: compression, streaming, SAH. Stated pitfall: "DAG traversal in a compute shader" was "too complicated", so it traverses a BVH of groups like Unreal. The post says simplifying merged clusters avoids cracks; whether group borders are explicitly locked is not clear from the digest: NOT VERIFIED. No performance numbers.

### 6e. Vulcanite (UPenn CIS 565 final project, Vulkan)

Link: https://github.com/bdwhst/Vulcanite (107 stars, last push 2024-07-02; READ, API).

READ: METIS clustering and grouping; own QEM edge collapse on OpenMesh; DAG; runtime rule `parentError > threshold && clusterError <= threshold`; BVH cluster culling; 64-bit software visbuffer with depth in the upper 32 bits and ClusterId 15 / ObjectId 11 / TriangleId 6 bits in the lower; mixed hardware/software raster. Listed as not done: locking group-boundary edges, mesh shaders, per-level BVH, compression, parallel build. Known issues: distant models flicker for an unknown reason; decimation "only accepts mesh whose faces are all connected". Numbers: coarse BVH culling removes "over 80%" of clusters for about 2x speed; hardware RTX 3060 / 4080 laptops; charts not readable as text.

### 6f. Pettett and Mantiuk, "Multiresolution Mesh Rendering Engine: Practicalities and Performance" (CESCG 2024, non-peer-reviewed)

Link: https://www.cl.cam.ac.uk/~rkm38/pdfs/pettett2024_multiresolution_mesh_rendering.pdf (READ in full via local text extraction of the fetched PDF).

- Vulkan + mesh shaders; clusters of "around 300 triangles"; build follows cluster, group (about 4), simplify with locked border edges, split each group into two parent clusters.
- Why a DAG and not a tree: a merge-pairs tree keeps some edges locked from the finest to the coarsest level, at the extreme bisecting the mesh with a ring of full-resolution edges; alternating which borders are locked at each level removes that.
- A valid cut needs every root-to-leaf path to contain exactly one selected node; monotonic screen-space error is enforced by making each cluster's bound contain its children's bounds.
- Object-space error is the cluster's average edge length (not simplifier error).
- Two runtime methods: "DAG Explore" (breadth-first traversal from the roots in compute, queue synchronised with subgroup arithmetic within a single workgroup per instance, avoiding Nanite's persistent threads which rely on undefined scheduling behaviour) and "Task Select" (every cluster tests itself locally in a task shader: draw when own error is under the threshold and parent error is above). Hole pitfall: a cluster's two parents can be in different groups with different errors; fix is to take the minimum error with the "spouse" cluster. Task Select caps the dispatch count from the previous frame's result (one frame of latency, with a fallback to draw the coarser cluster when children are not being processed).
- Numbers (GTX 1660, Ryzen 5 3600): Stanford dragon (1M triangles) x 1,000 instances = 1 billion triangles; mean frame times at 2,500 instances: LOD chain 4.10 ms, Task Select 2.27 ms, DAG Explore 2.37 ms; full-resolution 2,000-instance scene takes 472 ms. Draw-buffer memory at 2,500 instances: 38.82 MB for DAG Explore vs 29.31 KB for Task Select. Single Lucy (28M triangles) viewpoint: Task Select 1.28 ms vs LOD chain 9.15 ms GPU time.
- Not done: streaming.

### 6g. Esenthel Engine "Nanite-like Meshlets" branch

Link: https://esenthel.com/forum/showthread.php?tid=11834 (READ; forum post by user Fex dated 2026-07-14).

Vulkan only (`VK_EXT_mesh_shader`); clusters of 64 vertices / 124 triangles; groups simplified "with its outer boundary locked"; task + mesh shaders, visibility buffer, optional compute rasteriser; virtual shadow maps. Author-reported on RX 6650 XT at 3072x1296: 1M-triangle wall draws 71k triangles in 2.7 ms; 218M-triangle quarry scene draws 363k in 12.9 ms; bake of 1M triangles into about 22k clusters in about 1.8 s. Per-triangle culling was "measured SLOWER" and left off.

### 6h. NVIDIA nv_cluster_lod_builder and vk_lod_clusters

Links: https://github.com/nvpro-samples/nv_cluster_lod_builder (archived; README recommends "meshoptimizer/demo/clusterlod.h" instead), https://github.com/nvpro-samples/vk_lod_clusters (221 stars, active) (READ, both READMEs and API).

- Builder README states the crack-free conditions clearly: lock vertices on group borders; halve triangles per group; each group's bounding sphere is enlarged to also bound its generating geometry so error "never decreases"; draw a cluster when its group's error-over-distance is at or above the threshold and its generating group's is below; all clusters in a group share one decision. Limits: texture seams not preserved, attributes not fully handled.
- vk_lod_clusters uses a lightly modified `clusterlod.h`; compute-shader hierarchical traversal (`traversal_init`, `traversal_run`) outputs a render-cluster list; rasterises with mesh shaders or ray traces via cluster acceleration structures; streams groups on demand; compresses indices with `meshopt_encodeMeshlet` ("around 3x") and bit-packs positions/UVs. No frame-time numbers in the README.

### 6i. Others found
- JolifantoBambla/trichi (https://github.com/jolifantobambla/trichi): C++ cluster-hierarchy builder on meshoptimizer, METIS optional and discouraged ("slower and increases binary size"), parameters 64 vertices / 128 triangles / 4 clusters per group; "Faceted meshes are not supported"; has a WebGPU demo page at https://jolifantobambla.github.io/trichi/ whose content could not be read (title only). READ for README; demo NOT VERIFIED. 9 stars, last push 2025-04-06.
- moonlovelj/Nyx (https://github.com/moonlovelj/Nyx, read through the fork page https://github.com/unitycoder/Nyx): DX12 MiniEngine, meshlet DAG/BVH, mesh-shader dispatch, two-pass frustum + HZB, visbuffer to GBuffer, LZ4 page streaming (256 KB pages); defaults 128 vertices / 128 triangles, group size 32, BVH fan-out 8; stress scene Zorah at 4K on RTX 4070 Ti SUPER. READ (README via fork); 177 stars, active.
- SaschaWillems mesh-shader material: not found to cover cluster-LOD DAGs in this search; NOT VERIFIED either way.

---

## 7. Other WebGPU / WebGL meshlet or visibility-buffer work

- luma.gl "Virtual Geometry Canyon" (https://luma.gl/examples/experimental/virtual-geometry-canyon) (READ): WebGPU terrain demo around a `GPUVirtualGeometrySelection` primitive. Quadtree hierarchy (87,376 nodes, 65,536 finest clusters of a shared 640-triangle grid, about 41.9M theoretical triangles), GPU frustum + projected-error selection, compaction, one indexed indirect draw, "no render-loop readback". Uses skirts to hide T-junctions, so it is a quadtree terrain LOD, not a locked-boundary DAG. States it "does not implement asset streaming, compressed mesh clusters, software rasterization, or occlusion hierarchies".
- Cinevva "open world in the browser, part 21: visibility buffer" (https://app.cinevva.com/blog/2026-05-06-open-world-browser-part-21-visibility-buffer) (READ): a raw WebGPU two-pass visbuffer (`RG32Uint` instance + triangle id, triangle id baked as a flat per-vertex attribute because WebGPU has no portable fragment primitive index) compared with three.js forward shading for alpha-tested grass on an Apple M-series Mac at about 1080p. 50k instances: forward 5.51 ms vs visbuffer 4.13 ms; 200k instances: forward 5.44 ms vs visbuffer 7.80 ms. Conclusion: on tile-based GPUs forward was as good or better for that content; they would revisit for discrete GPUs or a meshlet architecture.
- trichi WebGPU demo (see 6i): exists, content NOT VERIFIED.
- expenses/lighthugger: visbuffer + meshlets with compute-emulated mesh shaders (SNIPPET only; native Vulkan as far as the snippet suggests; NOT VERIFIED).
- Usnul's Shade and 2026 WebGPU virtual geometry work: see 4c.
- three-virtual-geometry and Scthe/nanite-webgpu: see 4a and 3.

---

## Cross-cutting findings for a three.js implementation

Each line cites the section whose sources support it.

1. Build recipe has converged (sections 1, 2, 6h): clusters of about 128 triangles; groups of 8-16 (Bevy 8, clusterlod 16, three-virtual-geometry about 12, Nyx 32; older write-ups used 4); simplify each group to 50% with only group-border vertices locked, identified by position so attribute seams do not create false borders; re-split; store per cluster the group error/bounds and the coarser ("refined"/parent) group error/bounds.
2. Monotonic error is enforced, not assumed (sections 1, 2, 6a, 6f, 6h): take the max with the children's error and make bounds enclose the children's bounds. jglrxavpok and Bevy both shipped broken versions first.
3. Stuck simplification is the main quality problem (sections 1, 2, 3, 6a): causes are faceted/seam-heavy input and too many locked vertices. Remedies seen: position-only connectivity plus seam "protect" flags, permissive mode, sloppy fallback with inflated error, larger groups, welding, voxel proxies for foliage (4a), random triangle removal (3), and finally accepting terminal clusters.
4. METIS is no longer needed (sections 1, 4a, 5 NADE guide, 6i): `meshopt_partitionClusters`, or a simple greedy region-growing partition, is used by the newer projects. Bevy still uses METIS.
5. Cut selection can be a flat per-cluster test (sections 3, 4a, 6a, 6f) because the rule is local; a BVH over groups becomes necessary at very large instance counts (sections 2, 6d, 6h).
6. Browser WebGPU constraints reported by the sources: no 64-bit atomics, hence no Nanite-style visbuffer via atomics and only a 32-bit packed software raster (sections 2, 3); 128 MB storage-buffer binding limit in Chrome, handled by pooling (sections 3, 4a); no mesh shaders (INFERENCE; no source in this survey shows mesh shaders in a browser).
7. A hardware-raster-only design is the one demonstrated inside three.js (section 4a): compute culling and selection, index-buffer expansion, indexed indirect draw, vertex pulling from storage buffers through a TSL position node, standard materials. Its numbers come from one Apple M4 Pro machine and the author only.
8. WebGL2 (no compute shaders): the only WebGL evidence is Usnul's closed 2021-2022 system and three-nanite. Both started with CPU cut selection, and Usnul reports that re-uploading geometry per frame was the bottleneck until geometry stayed resident on the GPU (section 4c). A WebGL2 design would therefore need CPU (or transform-feedback) cut selection over resident cluster data and a multi-draw of cluster index ranges (INFERENCE).
9. Far-field cost: with a roughly one-pixel error target the cut still yields millions of small triangles; Scthe adds impostors (section 3), three-virtual-geometry adds draw-distance and triangle-budget controls (4a), NADE shows a case slower than the stock renderer (5).

---

## Comparison table

| Project | Platform | DAG build | Grouping | Cut selection | Culling | Raster | Visbuffer | Streaming | Open source | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| meshoptimizer clusterlod.h | C++ library | yes, reference | partitionClusters (16) | formula + optional BVH builder only | none | none | none | none | MIT | READ source |
| Bevy meshlets | wgpu native: Vulkan, Metal | yes | METIS (8) | GPU, BVH8 since 0.17 | frustum + two-pass HZB | SW compute (64-bit atomics) + HW | 64-bit, R64Uint texture | no | MIT/Apache | READ posts, source, docs |
| Scthe/nanite-webgpu | browser WebGPU (Chrome), Deno | yes, in-browser WASM | METIS (4) | GPU, flat per meshlet | frustum + single-pass HZB | SW compute (32-bit packed) + HW | no | no | MIT | READ README |
| three-virtual-geometry | three.js r180+ WebGPURenderer | yes, in-browser or CLI bake | greedy (about 12) | GPU, cells then flat | frustum, size, distance, HZB | HW only, indexed indirect | no | not described | MIT (per README) | READ README, docs |
| AIFanatic/three-nanite | three.js | yes (proof of concept) | METIS | not stated | none stated | three.js default | no | no (TODO) | MIT | READ README |
| Usnul Micron (2021-22) | three.js WebGL | yes | custom partitioner | CPU first, later GPU-side | partial | HW | no | no | closed | READ forum |
| Usnul WebGPU system (2026) | WebGPU | yes, streamable format | not stated | in progress | not stated | not stated | not stated | yes, HTTP range | closed | READ forum |
| Unity Virtual Mesh | Unity 6.3 URP, Vulkan | cluster LODs | not stated | GPU | two-pass, per triangle | HW indirect | not stated | partial | Unity Companion Licence | READ README |
| UNanite / VGeo | Unity 6 HDRP/URP, DX12 | yes | not stated | GPU | two-pass | SW + HW | yes | yes | GPL-3.0 + exception | READ README |
| Carrot (jglrxavpok) | Vulkan, mesh shaders | yes | METIS (4) | CPU, then task shader | frustum | HW mesh shader | 64-bit via fragment atomics | no (planned) | MIT | READ posts |
| SimNanite | DX12 | yes | METIS (4-8) | GPU BVH, MPMC queue | instance, BVH, cluster | SW + HW | 32-bit ids | no | MIT | READ post |
| Vulcanite | Vulkan | yes (own QEM) | METIS | GPU BVH | frustum + occlusion | SW + HW | 64-bit | no | MIT | READ README |
| Pettett CESCG 2024 | Vulkan, mesh shaders | yes (about 300 tris) | groups of 4 | GPU: BFS in compute, or local test in task shader | frustum | HW mesh shader | no | no | not stated | READ paper |
| vk_lod_clusters | Vulkan, mesh shaders / RT | clusterlod.h (modified) | as clusterlod | GPU hierarchical traversal | frustum + occlusion | HW mesh shader, or ray tracing | no | yes | Apache-2.0 | READ README |
| luma.gl canyon | browser WebGPU | no (quadtree terrain) | n/a | GPU | frustum | HW indexed indirect | no | no | open (visgl) | READ page |

---

## URLs that failed or returned no usable content

- https://blog.traverseresearch.nl/creating-a-directed-acyclic-graph-from-a-mesh-1329e57286e5 : HTTP 403.
- https://medium.com/traverse-research/creating-a-directed-acyclic-graph-from-a-mesh-1329e57286e5 : HTTP 403.
- https://web.archive.org/web/2024/https://blog.traverseresearch.nl/... : fetch tool cannot access web.archive.org.
- https://github.com/rpondicherry/VirtualGeometry : HTTP 404 (also 404 from the GitHub API).
- https://lvstri.github.io/ : HTTP 404 (guessed URL; no LVSTRI blog located).
- https://github.com/LVSTRI/IrisVk : fetched, but the repo has no README or description, so no feature claims could be read.
- https://jolifantobambla.github.io/trichi/ : fetched, but only the page title is available as text (script-driven demo).
- https://www.cl.cam.ac.uk/~rkm38/pdfs/pettett2024_multiresolution_mesh_rendering.pdf : the fetch tool could not parse the PDF; recovered by extracting text locally from the fetched copy, then read in full.
- https://github.com/bevyengine/bevy/pull/19318 : fetched, but the PR page carries no technical description of the BVH culling passes.
- https://bevy.org/news/bevy-0-14/ and https://bevy.org/news/bevy-0-15/ : pages exceed the fetch size limit; only the first 100,000 characters were read (the virtual geometry sections were within that range).
- Not fetched (search snippet only): Tencent NanoMesh slides, Arm NanoMesh blog, expenses/lighthugger, cnr-isti-vclab/nexus, jglrxavpok "The Plan" and "A basic material pass", Shade thread later pages.
