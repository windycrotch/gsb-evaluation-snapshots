# Browser GPU capabilities for a Nanite-like renderer in three.js

Research date: 11 Nov 2026. Web reading only. Every fact carries the URL it was read from.

Status legend
- **READ** = the page was fetched in this session and says what is stated.
- **SNIPPET** = seen only in a search-result summary; not fetched. Treat as NOT VERIFIED.
- **NOT VERIFIED** = could not be fetched / not found / inference.

Notes on method: pages were read through a fetch-and-summarise tool, so wording is paraphrased; long specs (WebGPU, WGSL, WebGL2) were only partly readable and the parts not reached are flagged. web3dsurvey percentages carry no date on the page; they are "as fetched on 11 Nov 2026".

---

## A. WebGL2

### 1. `WEBGL_multi_draw`

- **What it is** (READ, https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/): Community Approved (rev 6, 2020-07-31; last modified 2023-09-08). Written against WebGL 1.0, usable in WebGL1 and WebGL2. Adds `multiDrawArraysWEBGL`, `multiDrawElementsWEBGL`, `multiDrawArraysInstancedWEBGL`, `multiDrawElementsInstancedWEBGL`. Each behaves like N separate draw calls issued in one API call (lists of firsts/counts/offsets + `drawcount`). Implicitly enables `ANGLE_instanced_arrays`.
- **`gl_DrawID`** (READ, same page + https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_multi_draw): vertex-shader built-in giving the index of the draw inside a multi-draw call; 0 for non-multi draws. The shader must enable it with `#extension GL_ANGLE_multi_draw : require` (not `WEBGL_multi_draw`).
- **There is no indirect variant**: all draw parameters come from JS typed arrays, i.e. the draw list is CPU-authored (READ, registry page: only the four functions above).
- **Browser support** (READ, MDN browser-compat-data https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WEBGL_multi_draw.json): Chrome 86, Edge mirrors Chrome, Chrome Android mirrors, Safari 15, iOS Safari mirrors (15), **Firefox: false**, Firefox Android: false. MDN marks it "Limited availability", not Baseline (READ, MDN page above).
- **Measured availability** (READ, https://web3dsurvey.com/webgl2/extensions/WEBGL_multi_draw): 92.32% of WebGL2 sessions overall; Chrome 99.98%, Edge 100%, Safari 100%, iOS 100%, **Firefox 1.45%**; by platform Windows 92.45%, macOS 94.09%, Android 93.74%, Linux 61.63%.
- **Firefox**: tracking bug https://bugzilla.mozilla.org/show_bug.cgi?id=1536673 reported as open, P3, unassigned (SNIPPET — bug page not fetched). Consistent with BCD and the survey.
- **Consequence**: a WebGL2 path needs a non-multi-draw fallback for Firefox (three.js has one, see item 13).

### 2. `WEBGL_draw_instanced_base_vertex_base_instance` and `WEBGL_multi_draw_instanced_base_vertex_base_instance`

- **Status: both still Draft** (READ):
  - https://registry.khronos.org/webgl/extensions/WEBGL_draw_instanced_base_vertex_base_instance/ — WebGL extension #46, draft, WebGL2 only, last modified 2021-05-26. Adds `drawArraysInstancedBaseInstanceWEBGL`, `drawElementsInstancedBaseVertexBaseInstanceWEBGL`. Rev 3 removed the GLSL built-ins (`gl_BaseVertex`, `gl_BaseInstance` are **not** exposed).
  - https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw_instanced_base_vertex_base_instance/ — extension #47, draft, WebGL2 only, last modified 2023-09-08. Adds `multiDrawArraysInstancedBaseInstanceWEBGL`, `multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL`. Depends on the two extensions above. The page is internally inconsistent about `gl_DrawID` (sample still uses `GL_ANGLE_multi_draw`, rev 7 says GLSL builtins removed).
- **Browser support**: effectively none in shipping configurations. web3dsurvey shows **0.18%** for both (Chrome 0.22%, Edge 0.19%, Safari 0.09%, Firefox 0%, iOS 0%) (READ, https://web3dsurvey.com/webgl2/extensions/WEBGL_multi_draw_instanced_base_vertex_base_instance and https://web3dsurvey.com/webgl2/extensions/WEBGL_draw_instanced_base_vertex_base_instance). MDN browser-compat-data has no entry for either (the JSON URLs 404). That this residue corresponds to users with the "WebGL draft extensions" flag enabled is my inference — NOT VERIFIED.
- **Consequence**: cannot be relied on; per-draw base instance / base vertex in WebGL2 must be emulated (e.g. `gl_DrawID` -> data-texture lookup).

### 3. Compute, indirect draws, storage buffers in WebGL2

- **WebGL 2.0 Compute is dead** (READ, https://registry.khronos.org/webgl/specs/latest/2.0-compute/): Editor's Draft dated 31 March 2021; abstract says the spec "should be considered obsolete"; the WG halted WebGL expansion and "WebGPU will be the path forward for compute shaders on the web". So in WebGL2: no compute shaders, no SSBOs, no indirect draws, no image load/store.
- **No buffer mapping** (READ, https://registry.khronos.org/webgl/specs/latest/2.0/): `MapBufferRange` etc. are removed; readback is `getBufferSubData`, which the spec calls "a blocking operation".
- **What people use instead**
  - Transform feedback as pseudo-compute: three.js's own WebGL2 fallback emulates compute with `RASTERIZER_DISCARD` + `beginTransformFeedback(gl.POINTS)` + `drawArrays`, ping-ponging buffers (READ, https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl-fallback/WebGLBackend.js). Output is one record per input vertex; no scatter writes, no atomics.
  - Texture-based "vertex pulling" (`texelFetch` on data textures indexed by `gl_VertexID` / an integer attribute): https://webgl2fundamentals.org/webgl/lessons/webgl-pulling-vertices.html (SNIPPET — lesson not fetched). three.js `BatchedMesh` itself uses this pattern for per-instance matrices/ids (READ, item 13).

### 4. How ANGLE implements multi-draw and `gl_DrawID`

All READ from ANGLE `main` source (GitHub mirror), fetched 11 Nov 2026.

- **Shader side**: `gl_DrawID` is rewritten to an ordinary uniform `angle_DrawID`; `gl_BaseVertex` / `gl_BaseInstance` likewise to `angle_BaseVertex` / `angle_BaseInstance` (https://raw.githubusercontent.com/google/angle/main/src/compiler/translator/tree_ops/EmulateMultiDrawShaderBuiltins.cpp).
- **Generic path** (`MultiDrawArraysGeneral`, `MultiDrawElementsGeneral`, instanced variants): a CPU loop `for (drawID = 0; drawID < drawcount; ++drawID)` that sets the draw-ID uniform and calls the backend's single `drawArrays` / `drawElements` once per entry, then resets the uniform to 0 (https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/renderer_utils.cpp).
- **D3D11** (Chrome/Edge on Windows): `Context11::multiDraw*` expands the same loop macro inline — one D3D draw per entry plus a uniform update (https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/d3d/d3d11/Context11.cpp).
- **Metal** (Chrome and Safari on Apple): `ContextMtl::multiDraw*` forwards to the `rx::MultiDraw*General` loop (https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/metal/ContextMtl.mm).
- **Vulkan**: `ContextVk::multiDrawElements` etc. also forward to the `General` loop; only the GLES 3.1 *indirect* multi-draw path (not exposed to WebGL) uses a native `drawIndexedIndirect(..., drawcount, stride)` (https://raw.githubusercontent.com/google/angle/main/src/libANGLE/renderer/vulkan/ContextVk.cpp, bytes 200k–300k read; `multiDrawArrays` definition lay outside the portion read).
- **Conclusion**: on every ANGLE backend checked, `WEBGL_multi_draw` is **not a native GPU multi-draw**. It removes JS->GPU-process command and validation overhead per draw, but the driver still sees N draws and N uniform updates. The ANGLE OpenGL backend (`ContextGL`) was not read — NOT VERIFIED for that backend.

### 5. Occlusion queries and Hi-Z in WebGL2

- **Targets** (READ, https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/beginQuery and https://registry.khronos.org/webgl/specs/latest/2.0/): only `ANY_SAMPLES_PASSED` and `ANY_SAMPLES_PASSED_CONSERVATIVE` (boolean), plus `TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN`. No sample-count query.
- **Latency rule** (READ, WebGL2 spec URL above): a query's result "must never be made available to the application in the same frame the query was issued"; it only becomes available after control returns to the event loop. So query-based culling is always at least one frame late and costs one query object per tested object.
- **Hi-Z approaches seen in WebGL2** (READ, PlayCanvas discussion https://github.com/playcanvas/engine/discussions/8035, community author, Sep 2025 – Sep 2026; no maintainer endorsement of the technical claims):
  - depth -> texture -> manually built min/max mip chain, AABB tests in a shader;
  - results brought back either with transform feedback or with a small packed coverage/depth buffer read asynchronously through a PBO + `fenceSync` (about 128 KB, at least one frame of lag);
  - a CPU software HZB in a web worker as a mobile-friendly alternative;
  - the author's remark that without `multiDrawIndirect` in WebGPU a fully GPU-resident culling path is "pointless" because the draw list has to return to the CPU anyway.
- Older desktop-GL references for the same idea (RasterGrid Hi-Z map culling, NVIDIA `gl_occlusion_culling`) appeared only in search results — SNIPPET.

---

## B. WebGPU

### 6. Shipping status

Primary source: gpuweb Implementation Status wiki, last edited **2 Oct 2026** (READ, https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).

| Browser | Status |
|---|---|
| Chrome / Edge (Chromium, Dawn) | Windows x86/x64, macOS, ChromeOS: since **113**. Android 12+ (ARM/Qualcomm/Intel GPUs): since **121**; Imagination GPUs on Android 16+: 139; Samsung Xclipse and others: TBD. Linux: Intel Gen12+ since **144**; NVIDIA (driver 535.183.01+) on Wayland since **147**; other Linux behind flags. Windows ARM64: behind `--enable-unsafe-webgpu`. |
| Firefox (wgpu) | Windows: since **141**. macOS: 145 on macOS 26 (Apple silicon), **147** for older macOS on Apple silicon. Linux: Nightly only. Android: behind a pref. |
| Safari (WebKit) | **Safari 26** on macOS Tahoe 26, iOS 26, iPadOS 26, visionOS 26, enabled by default. |

Cross-checks
- MDN browser-compat-data (READ, https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/GPU.json): Chrome 113 (partial) / 144 (adds Linux Intel Gen12+), Chrome Android 121, Firefox 141 partial with notes: Windows since 141, macOS Tahoe/Apple silicon 145, older macOS/Apple silicon 147, "Does not support macOS on Intel CPUs", "Does not support Linux", no service workers; Firefox Android false; Safari 26, iOS Safari 26.
- caniuse (READ, https://caniuse.com/webgpu): Chrome 113+, Edge 113+, Safari 26.0+ ("partial"), iOS Safari 26.0+, Chrome Android supported, Samsung Internet 24+; global usage 86.83% + 1.8% partial. **Conflict**: caniuse lists Firefox 63–163 as "disabled by default", whereas the wiki and BCD say enabled on Windows since 141 and on Apple-silicon Macs since 145/147. caniuse appears to be treating partial-platform support as "disabled"; trust the wiki/BCD.
- web3dsurvey (READ, https://web3dsurvey.com/webgpu): 81.52% of sessions obtained a working WebGPU adapter.
- WebKit announcement dated 9 Jun 2025 confirms Safari 26 on macOS/iOS/iPadOS/visionOS (READ, https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/).
- Chrome Linux milestones: "WebGPU on Linux" in Chrome 144, "Linux NVIDIA" in 147–148 (READ, https://developer.chrome.com/docs/web-platform/webgpu/news).
- Firefox on Linux reaching stable after 2 Oct 2026: nothing found — NOT VERIFIED either way.
- Compatibility mode (GLES 3.1 / D3D11-class devices): `featureLevel: "compatibility"` in Chrome 146, Android 10+ on OpenGL ES 3.1 only; not in Firefox or Safari (READ, BCD JSON above).

### 7. Indirect draws and multi-draw indirect

- **Core**: `drawIndirect` (4 x u32) and `drawIndexedIndirect` (5 x u32: indexCount, instanceCount, firstIndex, baseVertex, firstInstance; 20 bytes) are in core. One call = one draw. Buffer needs `GPUBufferUsage.INDIRECT`, offset multiple of 4 (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndexedIndirect).
- **`indirect-first-instance`**: optional feature; without it a non-zero `firstInstance` in the indirect buffer makes the draw a no-op (READ, same MDN page + https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures). Present on 99.98% of WebGPU adapters surveyed (READ, https://web3dsurvey.com/webgpu). It is in the `GPUFeatureName` list of the spec dated 15 Sep 2026 (READ, https://www.w3.org/TR/webgpu/).
- **Multi-draw indirect: not standard, not shipped.**
  - Not among the 25 `GPUFeatureName` values in the 15 Sep 2026 Candidate Recommendation Draft (READ, https://www.w3.org/TR/webgpu/; only the first ~100k characters of the spec were readable, the feature list was inside that part).
  - No file for it under `gpuweb/proposals/` (READ, https://github.com/gpuweb/gpuweb/tree/main/proposals; listing may be truncated).
  - Spec PR #2315 "Add multi draw indirect feature" is still an **open draft**, Milestone 2; proposed shape `multiDrawIndirect(indirectBuffer, indirectOffset, maxDrawCount, drawCountBuffer?, drawCountOffset?)` and the indexed twin, feature name `multi-draw-indirect`. Open questions: a `maxMultiDrawIndirectCount` limit, Metal (needs indirect command buffers or a loop), render bundles (READ, https://github.com/gpuweb/gpuweb/pull/2315, last comments 16 Apr 2026).
  - Tracking issue #1354 "DrawIndirectCount": open, Milestone 2. kainino0x (22 Jan 2026): Dawn's implementation "has several issues", the largest blocked on migrating to Metal argument buffers. kainino0x (16 Apr 2026): the Dawn work is "not highly prioritized"; floated a CPU-side `WEBGL_multi_draw`-like alternative. A third-party wgpu Metal MDI PR was reported 11 Jun 2026 (READ, https://github.com/gpuweb/gpuweb/issues/1354).
  - Chrome: `chromium-experimental-multi-draw-indirect` since Chrome 131, adds `multiDrawIndirect()` / `multiDrawIndexedIndirect()` on the render pass encoder, only with `chrome://flags/#enable-unsafe-webgpu`; the post shows only a `maxDrawCount` argument (READ, https://developer.chrome.com/blog/new-in-webgpu-131). Still listed only as that Chrome 131 experimental item in the Chrome 155–156 changelog (READ, https://developer.chrome.com/blog/new-in-webgpu-155-156). Present on 0.13% of adapters surveyed (READ, https://web3dsurvey.com/webgpu).
- **Consequence**: GPU-driven culling today means either (a) one `drawIndexedIndirect` per cluster/bin slot with culled slots zeroed by compute (the emulation kainino0x describes in #1354), or (b) a single draw whose index/visibility stream is compacted by compute, or (c) read back and issue CPU draws.

### 8. Atomics in WGSL

- **Types** (READ, WGSL CR Draft dated 6 Nov 2026, section 6.2.8, https://www.w3.org/TR/WGSL/): `atomic<T>` where "T must be either u32 or i32". Atomics may only live in `workgroup` variables or `storage` buffers with `read_write` access; they are not constructible and can only be touched via the atomic built-ins (`atomicLoad`, `atomicStore`, `atomicAdd/Sub/Max/Min/And/Or/Xor`, `atomicExchange`, `atomicCompareExchangeWeak`).
- **No general 64-bit atomics, but a new narrow one** (READ, same spec + https://raw.githubusercontent.com/gpuweb/gpuweb/main/proposals/atomic-64-min-max.md):
  - WGSL has no 64-bit integer type. The spec now defines `atomic<vec2<u32>>` as a 64-bit unsigned value (low word in component 0, high in component 1), gated by the enable-extension `atomic_vec2u_min_max`, storage buffers only.
  - Built-ins `atomicStoreMax(ptr, v)` / `atomicStoreMin(ptr, v)`, compute or fragment stage, **no return value**, min/max only.
  - Matching API feature `atomic-vec2u-min-max` is in the WebGPU `GPUFeatureName` list of 15 Sep 2026 (READ, https://www.w3.org/TR/webgpu/).
  - Backend requirements per the proposal: Vulkan `shaderBufferInt64Atomics` (about 87.7% Linux, 31% Android per the proposal), Metal 2.4 / Apple9 family, D3D12 SM 6.6 with Int64 ops.
  - History (READ, https://github.com/gpuweb/gpuweb/issues/5071): opened 14 Feb 2025 citing Nanite; proposal accepted 30 Sep 2025; spec PR #5610 merged and issue closed **15 Sep 2026**; CTS landed 15 Jul 2026.
  - **Shipping status unknown**: not mentioned in Chrome's release posts up to 155–156 (READ, https://developer.chrome.com/blog/new-in-webgpu-155-156); not on MDN's feature list (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures); not listed by web3dsurvey (READ, https://web3dsurvey.com/webgpu). Dawn commits adding it experimentally for Vulkan, Metal and D3D12 exist (SNIPPET, dawn.googlesource.com). Which stable browser version exposes it: NOT VERIFIED.
- **What implementers do without it**
  - Scthe/nanite-webgpu (READ, https://github.com/Scthe/nanite-webgpu): "WebGPU does not have the `atomic<u64>` needed to implement this feature efficiently". Its software rasteriser packs **16-bit depth + 2x8-bit octahedral normal into one u32** and uses 32-bit `atomicMax`; no visibility buffer; the README admits 16-bit depth gives "tons" of z-fighting/leak artifacts. It lists alternatives it did not take: per-pixel linked lists, tile-based, or double rasterisation with `compareExchange`. Also notes "WebGPU does not have early-z", "Chrome ... 128MB limit for storage buffers (can be raised)", Chrome only.
  - Bevy meshlets (READ, https://jms55.github.io/posts/2024-11-14-virtual-geometry-bevy-0-15): native-only path using 64-bit `atomicMax` with depth in the high 32 bits and cluster id (25 bits) + triangle id (7 bits) in the low 32; the hardware raster fragment shader writes to the same atomic buffer; relies on wgpu 22 native u64 atomics, i.e. not available in browser WebGPU at the time. No 32-bit fallback is described. Bevy 0.16 moved to an R64Uint storage texture with texture atomics (SNIPPET, https://jms55.github.io/posts/2025-03-27-virtual-geometry-bevy-0-16).
  - The "two passes: 32-bit depth `atomicMax`, then re-rasterise and write payload where depth matches" idea is named in the Scthe README as "double rasterization" (READ) but I found no browser implementation write-up of it — NOT VERIFIED as practised.

### 9. Storage buffers / storage textures, limits

- **Default limits, core** (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits): `maxBufferSize` 268,435,456 (256 MB); `maxStorageBufferBindingSize` 134,217,728 (128 MB); `maxUniformBufferBindingSize` 65,536; `maxStorageBuffersPerShaderStage` 8; `maxStorageTexturesPerShaderStage` 4; `maxStorageBuffersInVertexStage` / `InFragmentStage` 8 / 8; `maxStorageTexturesInVertexStage` / `InFragmentStage` 4 / 4; `maxTextureDimension2D` 8192; `maxVertexBuffers` 8; `maxBindGroups` 4; `maxComputeInvocationsPerWorkgroup` 256; `maxComputeWorkgroupStorageSize` 16,384 bytes; `maxComputeWorkgroupsPerDimension` 65,535. Higher values must be requested via `requiredLimits`; browsers report tiered values.
- **What adapters actually offer** (READ, https://web3dsurvey.com/webgpu): `maxBufferSize` >= 1 GiB-ish (1,252,698,792) on 87%, >= 2,147,483,647 on 77%; `maxStorageBufferBindingSize` >= 536,870,912 on 95%, >= 1,252,698,792 on 79%, >= 2,147,483,647 on only 16%. So plan cluster/page pools as several <=128 MB (safe) or <=512 MB (95%) buffers, not one giant buffer.
- **Stage rules** (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBindGroupLayout): in the vertex stage a buffer binding must not be `"storage"` (read-write); `"read-only-storage"` is allowed — so vertex pulling from storage buffers works in core. MDN states a `storageTexture` entry cannot have VERTEX visibility at all; this may be stale relative to the current spec (which has `maxStorageTexturesInVertexStage` = 4 in core) — conflict noted, spec text for this not reached, NOT VERIFIED.
- **Read-only / read-write storage textures** (READ, https://developer.chrome.com/blog/new-in-webgpu-124): WGSL language feature `readonly_and_readwrite_storage_textures` (Chrome 124), detect via `navigator.gpu.wgslLanguageFeatures.has(...)`; example uses `r32uint`. That read-write is limited to `r32uint` / `r32sint` / `r32float` in core is recalled, not read — NOT VERIFIED. `texture-formats-tier2` "includes storage texture formats not available in core" (READ, MDN GPUSupportedFeatures). three.js r187 added "honors read-write storage textures in the WGSL fragment stage" (READ, https://github.com/mrdoob/three.js/releases/tag/r187).
- **Compatibility mode** (READ, https://raw.githubusercontent.com/gpuweb/gpuweb/main/proposals/compatibility-mode.md and https://www.w3.org/TR/webgpu/ limits table): `maxStorageBuffersInVertexStage` and storage textures in vertex stage default to **0**; fragment stage defaults to **4**; `maxTextureDimension2D` 4096; `maxUniformBufferBindingSize` 16,384; `maxComputeInvocationsPerWorkgroup` 128; no `textureLoad` on depth textures; no cube arrays; no `sample_mask`; views must cover the whole array; `flat` interpolation only as `either`. A storage-buffer vertex-pulling renderer therefore cannot assume compatibility-mode devices.
- **`primitive-index`** feature (READ, MDN GPUSupportedFeatures): fragment-stage `primitive_index` built-in, described as "useful for techniques such as virtualized geometry"; on 84.24% of adapters (READ, web3dsurvey). This is what a hardware-raster visibility buffer needs.

### 10. Mesh shaders

- Not in WebGPU; no proposal document (READ, https://github.com/gpuweb/gpuweb/tree/main/proposals — no mesh-shader file).
- Issue #3015 "Mesh shader support": open, labels `feature request`/`large`, "Milestone 4+". 10 Jul 2025: wgpu has a WIP native mesh-shading spec but "unlikely to be added to webgpu anytime soon". 27 Jun 2026: asked for news; reply that it should not be expected "anytime soon" (READ, https://github.com/gpuweb/gpuweb/issues/3015).
- A 2026 "tile shaders" proposal issue exists in the gpuweb group activity (SNIPPET) — unrelated to mesh shading.

### 11. Timestamp and occlusion queries

- **Occlusion** (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPUQuerySet and https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/beginOcclusionQuery): core. `createQuerySet({type:"occlusion", count})`, pass as `occlusionQuerySet` to `beginRenderPass`, bracket draws with `beginOcclusionQuery(i)` / `endOcclusionQuery()`. No nesting; an index may be written once per pass. Results are obtained with `resolveQuerySet` into a `QUERY_RESOLVE` buffer then async map (resolve step and "64-bit, zero = no samples passed" semantics are from general knowledge in the tool's answer, not on those MDN pages — NOT VERIFIED against the spec, but three.js's backend does exactly this, READ in item 14).
- **Timestamp** (READ, MDN GPUQuerySet + MDN GPUSupportedFeatures): requires optional feature `timestamp-query`; enables `timestampWrites` on render/compute pass descriptors. Present on 98.88% of adapters (READ, web3dsurvey). A `timestamp-query-inside-passes` proposal file exists (READ, proposals listing). Quantisation of timestamp values: NOT VERIFIED.
- A `pipeline-statistics-query.md` proposal file exists (READ, proposals listing); status not read.

### 12. Integrated vs discrete GPU, `powerPreference`

- **API** (READ, https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter): `powerPreference: "low-power" | "high-performance"` is a hint only. `forceFallbackAdapter` is specified but "no browser currently supports it". Chrome on dual-GPU **macOS** returns the discrete GPU on AC and the integrated one on battery when no preference is given (also in BCD as `discrete_adapter_default_ac`, Chrome 115, "dual GPU macOS devices only").
- **Chrome on Windows ignores it** (READ, https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips, last updated 17 Oct 2025): Chrome uses the same adapter it allocated for its other workloads, on laptops generally the integrated GPU, so `powerPreference` has no effect on `requestAdapter()`. Workaround: `chrome://flags/#force-high-performance-gpu` (or the OS per-app GPU setting — SNIPPET). Cited bug: **https://issues.chromium.org/issues/329211593** (Chrome does not support multiple GPU adapters at once).
- Whether this changed after Oct 2025: NOT VERIFIED. Design for the integrated GPU as the default target on Windows laptops.

---

## C. three.js

Current release: **r187**, released 30 Oct (2026; GitHub shows no year, `dev` branch `REVISION` is `188dev`) (READ, https://github.com/mrdoob/three.js/releases/tag/r187 and https://raw.githubusercontent.com/mrdoob/three.js/dev/src/constants.js).

### 13. `BatchedMesh`

- **Docs** (READ, https://threejs.org/docs/pages/BatchedMesh.html): "multi draw batch rendering"; one material, many geometries sharing an attribute layout; `perObjectFrustumCulled` (default true), `sortObjects` (default true), `setCustomSort`, `addGeometry(geometry, reservedVertexCount, reservedIndexCount)`, `addInstance(geometryId)`, `setGeometryIdAt`, `setVisibleAt`, `setMatrixAt`, `setColorAt`, `deleteGeometry`, `optimize`, `setGeometrySize`, `setInstanceCount`. Negative-scale matrices unsupported. **No LOD API** in core.
- **Per-frame CPU cost** (READ, https://raw.githubusercontent.com/mrdoob/three.js/dev/src/objects/BatchedMesh.js): draw lists are rebuilt on the CPU by looping over every instance, transforming its bounding sphere, `frustum.intersectsSphere`, optional depth sort with `Array.prototype.sort` (opaque front-to-back, transparent back-to-front), then writing `_multiDrawStarts` / `_multiDrawCounts` and an `_indirectTexture` (R32UI, draw slot -> instance id). Per-instance matrices live in an RGBA float `_matricesTexture`, colours in `_colorsTexture`. Early-out when nothing changed and both culling and sorting are off. So culling is O(instances) JS per frame per camera; there is no hierarchy.
- **WebGLRenderer** (READ, https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/WebGLRenderer.js and https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl/WebGLIndexedBufferRenderer.js): with `WEBGL_multi_draw`, one `multiDrawElementsWEBGL(mode, counts, 0, type, starts, 0, drawCount)`; without it (Firefox), a JS loop setting a `_gl_DrawID` uniform and issuing one draw per object.
- **WebGPURenderer, WebGPU backend** (READ, https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgpu/WebGPUBackend.js): **a JS loop of `drawIndexed(counts[i], instanceCount, starts[i]/bytesPerElement, 0, firstInstance)`**, with `firstInstance += instanceCount` so `instance_index` identifies the draw slot. No `multiDrawIndirect` path, no use of the Chrome experimental feature. New in r187: consecutive draws sharing a geometry range are merged into one instanced draw (`_mergedDrawStarts/_Counts/_InstanceCounts`; release note #35259) (READ, https://github.com/mrdoob/three.js/releases/tag/r187). Where the WebGPU path triggers the list rebuild was not located in the files read — NOT VERIFIED.
- **TSL**: `drawIndex` works only on WebGL2 inside a multi-draw; on WebGPU it errors and `instanceIndex` is used instead; Mugen87 (7 Nov 2025): multi-draw is not supported in WebGPU yet, to be revisited when multi-draw-indirect exists (READ, https://discourse.threejs.org/t/webgpu-tsl-equivalent-of-gl-drawid/87930).
- **WebGPURenderer, WebGL2 fallback** (READ, https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl-fallback/WebGLBackend.js): `renderMultiDraw` when the extension exists, else a loop setting a draw-id uniform.
- three.js maintainers want MDI: RenaudRohlinger on the spec threads (Apr 2026) says BatchedMesh depends on `WEBGL_multi_draw` and the blocker is CPU cost of about 100k indirect draws (READ, https://github.com/gpuweb/gpuweb/issues/1354).
- **Third-party LOD + BVH**: `@three.ez/batched-mesh-extensions` (READ, https://github.com/agargaro/batched-mesh-extensions): dynamic BVH over instances for frustum culling and raycast (`computeBVH`), `addGeometryLOD(geometryId, lodGeometry, distance)` with distance-based switching, per-instance uniforms (WebGLRenderer only), separate WebGL/WebGPU builds. Limit: "only LODs that share the same geometry vertex array" (index-only LODs, which is exactly what meshoptimizer `simplify` produces). You supply the simplified geometry. No releases/version date on the page. three.js ships an example `webgl_batch_lod_bvh` (READ, r187 notes).
- 3D Tiles: NASA `3d-tiles-renderer` has a BatchedMesh-based plugin (name recalled as `BatchedTilesPlugin`; not on the pages fetched — NOT VERIFIED).

### 14. `WebGPURenderer` features relevant here

- **Backends** (READ, https://threejs.org/docs/pages/WebGPURenderer.html): uses WebGPU when available, otherwise falls back to a WebGL 2 backend; `forceWebGL: true` forces the fallback.
- **Compute / storage in TSL** (READ, https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language, edited 24 Jun 2026): `Fn(...)().compute(count)` / `compute(node, count, workgroupSize=[64])`, `renderer.compute()`, `instancedArray`, `attributeArray`, `storage(attribute, type, count)`, `storageTexture`, `textureStore`, `struct`, atomics `atomicAdd/Sub/Max/Min/And/Or/Xor/Store/Load` (32-bit; no `atomicStoreMax`/vec2u listed), barriers, `workgroupId`/`localId`/`globalId`, `subgroupSize`; indices `instanceIndex`, `vertexIndex`, `drawIndex`. `renderer.computeAsync` and `compileComputeAsync` exist per release notes (READ, r186/r187 notes via https://github.com/mrdoob/three.js/releases). https://threejs.org/docs/TSL.html and `docs/TSL.md` returned 404.
- **Indirect draws** (READ, https://threejs.org/docs/pages/BufferGeometry.html and https://threejs.org/docs/pages/IndirectStorageBufferAttribute.html): `geometry.setIndirect(indirect, indirectOffset)`; `indirect` is "a (storage) buffer attribute which was generated with a compute shader and now defines indirect draw calls"; `indirectOffset` may be an **array**, in which case "multiple indirect draw calls will be made for each offset"; "Can only be used with WebGPURenderer and a WebGPU backend". Backend implementation is a JS loop of `drawIndexedIndirect(buffer, offsets[i])` / `drawIndirect` (READ, WebGPUBackend.js). So three.js already supports "N indirect draws from one compute-written buffer", at one API call per slot.
- **Occlusion queries** (READ, WebGPUBackend.js + WebGLBackend.js): set `object.occlusionTest = true`; WebGPU backend creates an occlusion query set per render context, one query per flagged object, resolves into a `QUERY_RESOLVE` buffer, maps it asynchronously and marks zero-result objects occluded; WebGL fallback uses `ANY_SAMPLES_PASSED` polled over `requestAnimationFrame`. Results lag by a frame or more. Cannot be recorded into render bundles. r186/r187 fixed stale queries and made results per camera (READ, releases page). Query via `renderer.isOccluded(object)` (method name seen in backend as `isOccluded()`; renderer docs for it not read).
- **Timestamps** (READ, both backend files): `trackTimestamp`, WebGPU `timestamp-query` pool (2048), WebGL fallback needs `EXT_disjoint_timer_query_webgl2` and cannot overlap timers.
- **What is lost on the WebGL2 fallback** (READ, WebGLBackend.js and docs above): no true compute (transform-feedback emulation only: per-element outputs, count must be a single number, no `IndirectStorageBufferAttribute` count), no indirect draws (`setIndirect` is WebGPU-backend only; the fallback's `draw()` does not reference `getIndirect`), no storage buffers/atomics/storage textures in the WGSL sense, reversed depth only with `EXT_clip_control`. A full list of unsupported nodes is not documented on the pages read.

### 15. `LOD` and automatic LOD tooling

- **`THREE.LOD`** (READ, https://threejs.org/docs/pages/LOD.html): per-object, camera-distance switching with `addLevel(object, distance, hysteresis)`, `autoUpdate`; discrete levels supplied by you; evaluated in JS each frame. No generation.
- **`SimplifyModifier`** (READ, https://threejs.org/docs/pages/SimplifyModifier.html): addon; the current docs say it is **based on meshoptimizer**, `await modifier.modify(geometry, count)` (async; `count` = approximate vertices to remove) and point to `MeshoptSimplifier` for index-only output. (This differs from the older Melax-style implementation I remember; the page read is the current one.)
- **meshoptimizer JS** (READ, https://raw.githubusercontent.com/zeux/meshoptimizer/master/js/README.md): `MeshoptSimplifier.simplify` (new index buffer over the same vertices), `simplifyWithAttributes` (attribute weights + vertex lock), `simplifyWithUpdate`, `simplifySloppy`, `simplifyPrune`, `simplifyPoints`, `compactMesh`, `getScale`; flags `LockBorder`, `ErrorAbsolute`, `Sparse`, `Prune`, `Regularize`, `RegularizeLight`, `Permissive`. `MeshoptClusterizer`: `buildMeshlets`, `buildMeshletsFlex`, `buildMeshletsSpatial`, `extractMeshlet`, `computeMeshletBounds`, `computeClusterBounds`, `computeSphereBounds`. No cluster-LOD/DAG builder in the JS module.
- **meshoptimizer C/C++** (READ, https://raw.githubusercontent.com/zeux/meshoptimizer/master/README.md): `meshopt_partitionClusters` (example partition size 24), `meshopt_simplifyWithUpdate`, `meshopt_SimplifySparse`, returned error convertible to object space with `meshopt_simplifyScale`; **`clusterlod.h`**, "a single-header library for continuous LOD using clustered simplification" (the Nanite-style hierarchy builder; C++ only, would need a custom WASM build or offline tool); meshlet codec `meshopt_encodeMeshlet` / `decodeMeshlet`. Both Scthe/nanite-webgpu and Bevy use meshoptimizer + METIS for the DAG (READ, items 8 sources).
- **glTF-Transform** (READ, https://gltf-transform.dev/modules/functions/functions/simplify): `simplify({ simplifier: MeshoptSimplifier, ratio, error })`, recommends `weld()` first; single output level, nothing about LOD sets on that page.
- **gltfpack** (READ, https://raw.githubusercontent.com/zeux/meshoptimizer/master/gltf/README.md): `-si R` simplify to ratio R; `-c` (EXT_meshopt_compression), `-cc` (higher compression), `-cz` (KHR_meshopt_compression, maximum), `-noq`, `-vpf`, `-cf` fallback buffers. No multi-LOD / `MSFT_lod` output documented. Other simplification flags (`-sa`, `-slb`, `-sv`) are not on that page — NOT VERIFIED.
- **`MSFT_lod`**: three.js `GLTFLoader` does not support it natively; community plugin routes exist (Hubs plugin, `three-gltf-extensions` "in progress", an unmaintained gist) — SNIPPET only, not fetched.
- **Needle `gltf-progressive`** (READ, https://cdn.jsdelivr.net/npm/@needle-tools/gltf-progressive@4.0.0-alpha.1/README.md): three.js plugin that lazily loads mesh and texture LODs (`NEEDLE_progressive` extension), LOD chosen by screen density; LODs generated by Needle Cloud / their Unity/Blender tools; registered on a glTF loader with a WebGL renderer. Closest existing "streamed discrete LOD" for three.js.

### 16. Impostors

- **agargaro/octahedral-impostor** (READ, https://github.com/agargaro/octahedral-impostor): repo exists, MIT, described as "wip", no releases/packages, 87 commits. The README body could not be read (raw README returned only the header).
- From the author's forum posts (SNIPPET, https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318 and https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735): API `new OctahedralImpostor({ renderer, target, useHemiOctahedron: true, ... })`; used as the far LOD on `InstancedMesh2` (BVH culling, a meshoptimizer mid LOD from 15–100 units, impostor beyond 100); author says more work is needed before it is "truly usable". A WebGPU/TSL octahedral impostor forest demo and a TSL crowd demo ("Horde") are mentioned — not fetched.
- Parameters such as atlas resolution, sprites per side, depth/parallax, lighting support, WebGPU support of the library: NOT VERIFIED.
- Reference point (READ, https://github.com/Scthe/nanite-webgpu): that project uses 12-view billboard impostors around the up axis with dithered blending, storing diffuse + normals, and "does not handle up/down views".

---

## D. Compression and streaming

### 17. meshopt compression

- **`EXT_meshopt_compression`** (READ, https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md): "Complete, Ratified by the Khronos Group". Compresses bufferViews (vertex, index, morph, animation, instancing data) in modes ATTRIBUTES / TRIANGLES / INDICES with filters OCTAHEDRAL / QUATERNION / EXPONENTIAL; each bufferView independently, decodable straight into GPU-bound storage; decoders "run at ~1 GB/sec on modern desktop hardware" with WebAssembly SIMD; output is meant to be further compressed with deflate/brotli/zstd; fallback buffers supported. No numeric ratio and no Draco comparison on the page.
- **`KHR_meshopt_compression`** (READ, https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_meshopt_compression/README.md): **Release Candidate** (no date on page). Adds the v1 vertex codec (better bit packing / delta modes) and a COLOR filter (YCoCg); v0 kept for compatibility; same ~1 GB/s WASM SIMD statement. Loader support in three.js/Babylon not stated on the page — NOT VERIFIED.
- **Codec numbers from the meshoptimizer README** (READ, https://raw.githubusercontent.com/zeux/meshoptimizer/master/README.md): vertex codec about **2–4x** smaller than already-quantised data, native decode **3–6 GB/s**; index codec about **1–1.2 bytes per triangle** on real meshes (best case 1 byte, about 6x smaller than 16-bit indices), decode 3–6 GB/s; filters 5–10 GB/s with SIMD; vertex format v1 default since v0.23, level 3 for extra ratio; meshlet codec 5–7 bits/triangle for topology (9–12 bits with vertex references), decode 7–10 GB/s. JS/WASM decoders: "1–3 GB/s on modern desktop computers" with SIMD, worker pool via `useWorkers(n)` + `decodeGltfBufferAsync` (READ, https://raw.githubusercontent.com/zeux/meshoptimizer/master/js/README.md).
- **Draco**: the meshoptimizer README only says Draco aims for maximum ratio at the cost of vertex order and decode speed; no numbers (READ, same README). Any specific "X times smaller / slower" figure: NOT VERIFIED.
- Note for cluster data: Draco reorders vertices, which breaks externally stored cluster/meshlet index ranges; meshopt codecs preserve order (the order-preservation of meshopt is implied by the README's Draco remark, not stated as a guarantee on the pages read).

### 18. Streaming over HTTP range requests (Nanite page-streaming analogues)

- **Potree 2.0** (READ, https://raw.githubusercontent.com/potree/potree/develop/src/modules/loader/2.0/OctreeLoader.js and https://github.com/potree/PotreeConverter): the whole point cloud is 3 files (`metadata.json`, `hierarchy.bin`, `octree.bin`). The loader reads `metadata.json`, range-fetches hierarchy chunks (`'Range': bytes=first-last` on `hierarchy.bin`, 22-byte node records carrying `byteOffset`/`byteSize`; proxy nodes point to further hierarchy chunks), then range-fetches each node's byte span from `octree.bin` and decodes in a worker pool (optional Brotli). This is the closest structural match to Nanite's "hierarchy + fixed pages addressed by offset".
- **Spark 2.0 (World Labs, three.js Gaussian splats)** (READ, secondary article https://radiancefields.com/world-labs-previews-spark-2.0, byline 20 Feb 2026): `.RAD` format stores a precomputed LoD splat tree and "supports HTTP Range requests"; coarse-first refinement; a shared LRU "splat pager" with a fixed pre-allocated GPU pool that fetches/evicts chunks by view relevance; a fixed per-frame splat budget (about 0.5–2.5 M by device class). Primary Spark docs not read.
- **3D Tiles / `3d-tiles-renderer`** (READ, https://github.com/NASA-AMMOS/3DTilesRendererJS): three.js/Babylon/PlayCanvas renderer; one HTTP resource per tile rather than byte ranges; refinement driven by `errorTarget`; LRU cache with `maxSize` / `maxBytesSize` — when full, "no new tiles load" and coarser tiles stay. Details of the SSE traversal, queues and the batched plugin were not on the page read — NOT VERIFIED.
- **Other splat viewers** (SNIPPET): KSPLAT chunk table enabling byte-range fetches; chunk-level LOD streaming viewers (AHOLO, Splatter.app); "Gaussian Splat Lite 1.0 ... streaming LOD" for three.js.
- **Mesh/Nanite-like on the web**: no production cluster-page streamer found. Scthe/nanite-webgpu explicitly has "no VRAM streaming" and "no compression" (READ). three.js `GLTFLoader` range-request loading exists only as a feature request/plugin experiments (SNIPPET).

---

## Summary table

| Capability | WebGL2 | WebGPU | three.js support | Browser support | Source |
|---|---|---|---|---|---|
| CPU-authored multi-draw | `WEBGL_multi_draw` (+`gl_DrawID`); ANGLE loops per draw internally | none (loop of `drawIndexed`) | `BatchedMesh`: multi-draw on WebGL, JS loop on WebGPU, merged identical ranges in r187 | Chrome/Edge 86+, Safari/iOS 15+, **not Firefox** | registry.khronos.org/webgl/extensions/WEBGL_multi_draw/ ; BCD WEBGL_multi_draw.json ; ANGLE renderer_utils.cpp ; three.js WebGPUBackend.js |
| Base vertex / base instance | draft extensions only (0.18%) | native args on `draw*`; `firstInstance` in indirect needs `indirect-first-instance` (99.98%) | WebGPU backend uses `firstInstance` as draw id | n/a WebGL; WebGPU everywhere | registry pages #46/#47 ; web3dsurvey ; MDN drawIndexedIndirect |
| Indirect draw (single) | no | core | `geometry.setIndirect` + `IndirectStorageBufferAttribute`, array of offsets = N calls | all WebGPU browsers | MDN ; threejs.org/docs BufferGeometry |
| Multi-draw indirect / draw count | no | **not standard**; Chrome flag-only experiment since 131 | none | 0.13% of adapters | gpuweb PR 2315, issue 1354 ; new-in-webgpu-131 ; web3dsurvey |
| Compute shaders | no (spec obsolete); transform feedback | core | TSL `compute()`, `storage()`, `instancedArray`; WebGL fallback = transform feedback emulation | all WebGPU browsers | 2.0-compute spec ; TSL wiki ; WebGLBackend.js |
| Storage buffers in vertex/fragment | no (data textures) | core: 8 per stage, read-only in vertex; compat mode 0 in vertex | TSL `storage()` | core WebGPU; not compat mode | MDN GPUSupportedLimits ; compatibility-mode.md |
| Big buffers | texture size bound | defaults 256 MB buffer / 128 MB binding; >=512 MB binding on 95% | must request `requiredLimits` | varies by adapter | MDN GPUSupportedLimits ; web3dsurvey |
| 32-bit atomics | no | `atomic<u32/i32>` in storage/workgroup | TSL atomic* | all WebGPU browsers | w3.org/TR/WGSL 6.2.8 |
| 64-bit atomic min/max | no | in spec since Sep 2026 (`atomic-vec2u-min-max`, `atomicStoreMax`); shipping status unknown | not in TSL list | NOT VERIFIED | proposals/atomic-64-min-max.md ; gpuweb issue 5071 |
| `primitive_index` in fragment | `gl_PrimitiveID` absent | optional feature `primitive-index` (84%) | not checked | Chrome et al. per survey | MDN GPUSupportedFeatures ; web3dsurvey |
| Mesh shaders | no | no, no proposal, "not anytime soon" | no | none | gpuweb issue 3015 |
| Occlusion queries | boolean, >=1 frame late | core, boolean-style via query set | `object.occlusionTest` on both backends | all | WebGL2 spec ; MDN GPUQuerySet ; three backends |
| Hi-Z culling | manual mip chain + TF or PBO readback | compute + indirect args (no MDI) | none built in | — | playcanvas discussion 8035 |
| Timestamp queries | `EXT_disjoint_timer_query_webgl2` | optional `timestamp-query` (98.9%) | `trackTimestamp` | most | MDN ; web3dsurvey ; three backends |
| Adapter choice | `powerPreference` context attr (not researched) | `powerPreference` hint; ignored by Chrome on Windows | passes through (not checked) | Chrome Windows -> integrated GPU | developer.chrome.com troubleshooting-tips ; crbug 329211593 |
| LOD | — | — | `THREE.LOD` (discrete, CPU); `@three.ez/batched-mesh-extensions` LOD + BVH; `SimplifyModifier` / `MeshoptSimplifier` | — | threejs.org/docs LOD, SimplifyModifier ; agargaro repo ; meshoptimizer js README |
| Cluster DAG build | — | — | none; meshoptimizer `clusterlod.h` (C++), clusterizer in WASM | — | meshoptimizer README |
| Impostors | — | — | third-party, WIP (`agargaro/octahedral-impostor`) | — | github repo (partly unverified) |
| Geometry compression | — | — | `EXT_meshopt_compression` (ratified), `KHR_meshopt_compression` (RC); ~1 GB/s WASM SIMD decode | needs WASM (SIMD for speed) | Khronos glTF extension READMEs ; meshoptimizer README |
| Page streaming | — | — | none for meshes; analogues: Potree 2.0 range requests, Spark `.RAD`, 3D Tiles LRU | HTTP Range on any static host/CDN that honours it | potree OctreeLoader.js ; radiancefields.com Spark 2.0 ; 3DTilesRendererJS |

## Items not verified (collected)

1. Firefox bug 1536673 state (search snippet only).
2. Why 0.18% of sessions report the base-vertex/base-instance draft extensions (flag inference).
3. webgl2fundamentals vertex-pulling lesson (not fetched).
4. ANGLE OpenGL backend multi-draw path; `ContextVk::multiDrawArrays` body (outside the portion read).
5. Whether Firefox shipped WebGPU on Linux stable after 2 Oct 2026.
6. Which stable browser versions, if any, expose `atomic-vec2u-min-max`.
7. "Two-pass depth then payload" software raster as actually practised in a browser renderer.
8. Read-write storage texture format list (`r32uint/sint/float`), and whether storage textures are allowed in the vertex stage in current core spec (MDN vs limits table conflict).
9. WebGPU spec text for occlusion-query result values and timestamp quantisation (spec only partly readable).
10. Whether Chrome on Windows still ignores `powerPreference` after Oct 2025.
11. Where the WebGPU path rebuilds BatchedMesh draw lists; 3d-tiles-renderer batched plugin details.
12. `renderer.isOccluded` docs; complete list of TSL features unsupported on the WebGL2 fallback.
13. gltfpack simplification flags beyond `-si`; `MSFT_lod` loader plugins for three.js.
14. Octahedral impostor library parameters, limits and WebGPU support.
15. Any numeric Draco vs meshopt comparison; three.js/Babylon support for `KHR_meshopt_compression`.
16. Primary Spark 2.0 documentation; KSPLAT/AHOLO/Splatter streaming details; 3D Tiles traversal specifics.
