# Frame history trust (stochastic renderer)

The stochastic splat renderer improves each image with temporal accumulation (TAA): every frame
leaves one random coverage sample, and a resting camera folds successive frames together until the
image converges. The accumulation, the previous-frame occlusion cull and a stereo session's shared
projection all read data a previous frame produced — its colour and info textures, its depth, and
the view/projection matrices that reproject them.

That reuse is only sound while the remembered frame actually describes the frame being rendered.
A resized canvas, a different render target, a switched history colour format, a perspective↔
orthographic change, the start or end of a stereo session, or a removed resident node can all make
the remembered colour, depth or matrices belong to a different image. Reading them anyway produces
ghosting, wrong occlusion culling, or a frame that never refreshes.

## One explicit state, two trust flags

`src/render/frame-history.ts` (`FrameHistory`) is the single source of truth for whether a view's
remembered frame may be reused. Each `SplatView` owns one, so a stereo session has one independent
state per eye. It holds no GPU objects and no engine imports, which lets the whole lifecycle run as
unit tests against constructed frame sequences (`test/render/frame-history.test.mjs`).

- `historyValid` — the TAA ping-pong colour/info and the previous TAA matrices describe the
  previous on-screen frame in this frame's layout, so the resolve may reproject them. When false
  the resolve starts from this frame's own sample (the shader's `taaParams.y` history-valid gate).
- `depthValid` — the depth texture, the occlusion grid reduced from it and the previous projector
  matrices describe the same world at the same size, so the occlusion cull and a shared stereo
  projection may reuse them.

The renderer feeds each frame's plain facts into `beginFrame` **before any previous-frame texture
or matrix is bound**, and calls `endFrame` once the frame has drawn:

- `FrameSignature` — the layout that must match: size, render target, history colour format,
  projection type, warp table and stereo flag. A mismatch drops both trusts with a recorded reason
  (`resize`, `target`, `history-format`, `projection`, `warp`, `stereo`).
- `FrameOutcome` — whether the frame accumulates, whether the view moved or the scene changed, and
  whether it is an offscreen/query frame. Query frames never read the on-screen history and are
  never recorded as a previous frame.
- `restFrames` and `frameWanted` drive convergence: a resting camera keeps requesting frames until
  the accumulation fills its sample cap (`taaMax`, plus two frames of margin), then goes quiet.

## Invalidation rules

| Event                                               | Colour history (`historyValid`)      | Depth cull (`depthValid`)                         |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| Canvas / render-target size change                  | reset, rebuild from this frame       | reset                                             |
| Render target change (a capture draws elsewhere)    | not read; query frame not recorded   | not read                                          |
| History colour format change (fixed ↔ half float)   | reset; old-format textures destroyed | reset                                             |
| Projection type change (perspective ↔ orthographic) | reset (different clip mapping)       | reset                                             |
| Warp table / layout change                          | reset                                | reset                                             |
| Stereo session start or end                         | reset on every surviving view        | reset                                             |
| Resident node removed                               | kept (the resolve re-clamps it)      | **reset** — its depth may hide what is now behind |
| New node arrives                                    | kept                                 | **kept** — arrivals never make a depth wrong      |
| Variant switch / explicit reset / detach            | reset                                | reset                                             |

A node removal is the one event that drops depth trust alone (`noteNodesRemoved`): thinning the
world can reveal what an occluder used to hide, so the previous depth must not cull, but the colour
mean stays valid and converges the new content in. New nodes streaming in are not removals, so they
never needlessly switch the cull off.

## Stereo

On a stereo session the renderer grows one `SplatView` per eye and shrinks back to one when it
ends. The transition explicitly invalidates every surviving view, and the signature's `stereo`
flag is a per-frame backstop: a flat camera's matrices can never serve an eye, nor an eye's the flat
camera. In a `stereo:shared` projection the lead eye projects for both, but each eye still runs its
own `beginFrame`/`endFrame`, accumulates its own colour history and records its own matrices — the
follow eye only borrows the lead's projection, never its trust flags.

## Recovery and the no-shortcut rule

After any invalidation, a stationary camera re-converges in a finite number of frames: the first
frame renders without reading history, `frameWanted` keeps the frames coming while `restFrames` is
below the cap, and both trusts become live again. Neither TAA nor occlusion culling is ever switched
off permanently to force a test to pass — the tests assert both recover, and that frames keep being
requested through the recovery.
