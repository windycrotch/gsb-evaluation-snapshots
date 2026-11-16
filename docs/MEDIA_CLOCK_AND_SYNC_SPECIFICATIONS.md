# Universal Media Clock & Dual-Tier Synchronization Specifications

This document is the authoritative technical specification for **Layer 2 (`src/media/`)** and **Layer 3 (`src/hooks/`)** in **StageFlow**. It is governed by [`AGENTS.md`](../AGENTS.md).

---

## 1. Universal `MediaClockDriver` Contract (`src/media/mediaTypes.ts`)

To guarantee 100% behavioral parity whether the user is analyzing a local `.mp4`/`.webm` file, a YouTube link, or a zero-asset procedural blueprint scene, the 3D diorama and transport controls never couple directly to a raw `<video>` tag. Instead, they interact strictly through [`MediaClockDriver`](../src/media/mediaTypes.ts):

```typescript
export interface MediaClockDriver {
  readonly kind: 'html5' | 'youtube' | 'procedural';
  isReady(): boolean;
  isPlaying(): boolean;
  getCurrentTime(): number; // Frame-accurate in seconds at 60fps
  getDuration(): number;    // Total duration in seconds
  getPlaybackRate(): number;
  isMuted(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(timeSec: number): void;
  setDuration?(durationSec: number): void;
  setPlaybackRate(rate: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}
```

### Automatic Source Classification (`classifyMediaSource`)
[`classifyMediaSource(rawUrl)`](../src/media/mediaTypes.ts) inspects `score.videoUrl` (or user-supplied override URLs):
1. **YouTube (`'youtube'`)**: Matches `youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/embed/<id>`, `youtube.com/shorts/<id>`, or raw 11-character video IDs via `extractYouTubeId()`.
2. **Procedural Simulator (`'procedural'`)**: Matches `procedural://...` or empty strings.
3. **HTML5 Video (`'html5'`)**: Matches local relative paths (`/media/...`), full HTTP video URLs, and drag-and-dropped local file `blob:` URLs.

---

## 2. Pluggable Media Drivers (`src/media/`)

### 2.1 `Html5MediaDriver` (`html5MediaDriver.ts`)
- Binds directly to the mounted `<video>` element in [`UniversalVideoViewport.tsx`](../src/ui/UniversalVideoViewport.tsx).
- Reads `video.currentTime` synchronously at 60fps and forwards native `play`, `pause`, `loadedmetadata`, `ratechange`, and `ended` events.
- **Optimistic In-Flight Seek Latch**: During asynchronous keyframe demuxing (`video.seeking === true`), `getCurrentTime()` holds `pendingSeekSec` rather than reporting stale or un-seeked video timestamps until the native `seeked` event fires (or a 500ms safety timeout elapses).
- **Scrub Clamping & Paused Pinning**: `seek(timeSec)` clamps the target to $[0, \text{duration}]$ before touching the element, and the most recently displayed time is cached (`lastCurrentTimeSec`). Repeated 60fps reads while paused always return the seek target — the clock never extrapolates forward.
- **Rate Re-Anchor & Clamp**: `setPlaybackRate(rate)` first re-anchors at the currently displayed time (re-syncing any in-flight optimistic seek so the playhead cannot jump), then clamps to the HTML5-native **$0.1\text{x}$–$4.0\text{x}$** band before assigning `video.playbackRate`.
- **Destroy Quarantine**: `destroy()` snapshots the final displayed time, removes every native listener, pauses the element, and flips a `destroyed` flag. Post-destroy reads return the frozen snapshot without touching the detached `<video>`, and all transport commands (`play`/`pause`/`seek`/`setPlaybackRate`/`setMuted`) become no-ops so a source switch can never drive the retired driver.

### 2.2 `YouTubeMediaDriver` & 60fps Drift-Corrected Extrapolation (`youtubeMediaDriver.ts`)
- Dynamically loads `https://www.youtube.com/iframe_api` via a singleton promise and mounts an chromeless player (`controls: 0`, `disablekb: 1`, `modestbranding: 1`, `rel: 0`, `playsinline: 1`). The loader and its `.then()` mount callback are guarded with `typeof window === 'undefined'` so non-DOM environments (e.g. Node unit tests) never produce unhandled rejections.
- **Solving IFrame `postMessage` Polling Latency**:
  - Because YouTube's `player.getCurrentTime()` updates over an asynchronous `postMessage` bridge at ~10–15Hz, reading it raw at 60fps would cause visible camera stepping.
  - `YouTubeMediaDriver` solves this via **high-resolution clock extrapolation**:
    1. Whenever `player.getCurrentTime()` reports a new timestamp (`Math.abs(rawYtTime - lastPolledYtTime) > 0.001`), it re-anchors `anchorVideoTimeSec = rawYtTime` and `anchorPerfTimeMs = performance.now()`.
    2. On intermediate 60fps animation frames while playing, `getCurrentTime()` returns:
       $$t_{\text{extrapolated}} = \text{anchorVideoTimeSec} + \frac{\text{performance.now()} - \text{anchorPerfTimeMs}}{1000} \times \text{playbackRate}$$
    3. When `seek(targetSec)` is invoked (e.g. scrubbing while paused or frame-stepping), `anchorVideoTimeSec` updates **synchronously on the same call stack** before `player.seekTo(targetSec, true)` is dispatched, giving the 3D diorama **0ms scrub latency**. The target is clamped to $[0, \text{duration}]$.
- **In-Flight Seek Protection (Anti-Reversion Guard)**:
  - While YouTube processes `seekTo(targetSec)` asynchronously, incoming `player.getCurrentTime()` queries reporting stale pre-seek timestamps are filtered out until YouTube's clock catches up to within $1.5\text{s}$ of the target (or a 600ms safety timeout guard fires). This prevents the scrubber and 3D diorama from rubberbanding back to the pre-seek time.
  - When the 600ms guard fires while **paused**, the latch is released but the requested anchor is retained instead of adopting the stale polled timestamp, guaranteeing paused scrub reads stay pinned to the target with zero extrapolation. While playing, the guard re-anchors to the latest polled time as before.
- **Rate Re-Anchor & Clamp**: `setPlaybackRate(rate)` snapshots `getCurrentTime()` into the anchor before applying the new rate, then clamps to the IFrame-supported **$0.25\text{x}$–$2.0\text{x}$** band and calls `player.setPlaybackRate()`, eliminating instantaneous playhead jumps on speed changes.
- **Destroy Quarantine**: `destroy()` freezes the final displayed anchor, nulls the player after invoking its `destroy()`, and flips `destroyed`. Subsequent `getCurrentTime()` calls return the frozen anchor without polling the torn-down IFrame, and transport commands are no-ops.

### 2.3 `ProceduralMediaDriver` (`proceduralMediaDriver.ts`)
- Pure `performance.now()` virtual clock used by `procedural://` blueprint scenes.
- Paired with a 60fps true 3D Stage Cam Viewport (`StageCamMonitorCanvas.tsx` / `StageCamViewRig.tsx`) in [`UniversalVideoViewport.tsx`](../src/ui/UniversalVideoViewport.tsx) that renders the shared 3D diorama scene directly through the Stage Camera's lens with a rule-of-thirds safe-action reticle and live optical lens telemetry strip.
- **Scrub Clamping & Paused Pinning**: `seek(timeSec)` clamps to $[0, \text{durationSec}]$; while paused `getCurrentTime()` returns the anchor verbatim, so repeated reads never drift regardless of wall-clock advancement.
- **Rate Re-Anchor & Clamp**: `setPlaybackRate(rate)` unconditionally re-anchors `anchorTimeSec` to the currently displayed time and resets `anchorPerfMs` before applying the rate clamped to **$0.25\text{x}$–$2.0\text{x}$**, preventing jumps when switching speed while paused or playing.
- **Duration-Shrink Clamp**: `setDuration(newDurationSec)` enforces the $0.5\text{s}$ minimum; if the current playhead exceeds the new duration, the anchor is clamped to the new end (and the perf anchor reset), whether the clock is paused or playing.
- **Destroy Quarantine**: `destroy()` freezes the anchor at the displayed time and flips `destroyed`; post-destroy reads return the frozen value and all transport commands plus `setDuration()` become no-ops.

### 2.4 Source Switch Lifecycle (`useMediaClock.ts`)
- When the classified `sourceInfo` changes, the driver-instantiation effect tears down the previous driver via its `destroy()` quarantine contract before constructing the replacement, and nulls `driverRef` when it still points at the retired instance. The old driver is therefore never read or commanded after a switch.
- Every freshly constructed driver begins life **paused at $t=0$** (HTML5/YouTube mount with autoplay disabled; the procedural clock starts with `playing = false`), and `setIsPlaying(false)` is dispatched synchronously on each switch.

---

## 3. Dual-Tier 60fps Render & State Architecture (`src/hooks/useStageFrameLoop.ts`)

To maintain locked 60fps rendering in Three.js without triggering React component tree reconciliation on every animation frame, StageFlow enforces a strict **Two-Tier State Engine**:

```mermaid
sequenceDiagram
    participant R3F as R3F useFrame (60fps)
    participant Loop as useStageFrameLoop
    participant Core as computeStageFrame(t)
    participant Three as Three.js Rigs (StageCam / Mannequins / ObserverCam)
    participant UI as React 2D UI (~10Hz Throttled)

    R3F->>Loop: evaluateTick60fps() (Priority -1)
    Loop->>Core: computeStageFrame(driver.getCurrentTime(), score)
    Core-->>Loop: nextFrame (StageFrame)
    Loop->>Loop: Mutate frameRef.current = nextFrame
    R3F->>Three: Read frameRef.current & mutate Object3D transforms directly
    alt Every >= 95ms OR Shot Changed OR Entity Cue Changed OR Paused/Seeked
        Loop->>UI: setUiSnapshot({ timestampSec, frame, liveViewportPose })
    end
```

1. **Tier 1 — Imperative 60fps Ref Path (`frameRef`, `liveViewportPoseRef`)**:
   - Inside [`DioramaCanvas.tsx`](../src/stage/DioramaCanvas.tsx), `FrameLoopTicker` runs at `useFrame` priority `-1`, calling `evaluateTick60fps()` once per rendered frame.
   - **On-Demand Idle Zero-Churn (`frameloop="demand"`)**: Both [`DioramaCanvas.tsx`](../src/stage/DioramaCanvas.tsx) and [`StageCamMonitorCanvas.tsx`](../src/stage/StageCamMonitorCanvas.tsx) switch between `frameloop="always"` during playback and `frameloop="demand"` when paused, waking strictly on explicit user orbit/zoom interactions, resize events, prop/score edits (`CanvasDemandInvalidator` / `MonitorDemandInvalidator`), async 3D text syncs (`<Text onSync={invalidate}>`), or camera presets (`cameraPresetSeq`).
   - **Pure Idle Evaluation Guard (`canReuseIdleStageFrame`) & Lazy Init**: [`useStageFrameLoop.ts`](../src/hooks/useStageFrameLoop.ts) lazily initializes frame `0` once per hook instance (`initFrameRef`) and short-circuits `evaluateTick60fps()` when paused at an unchanged timestamp, unchanged `score` reference, and zero pending manual seeks or score resets.
   - **Synchronous & Settled Seek Invalidation (`onTimeJump`, `onSeekSettled`)**: [`useMediaClock.ts`](../src/hooks/useMediaClock.ts) fires its optional `onTimeJump` callback on manual seeks, frame steps (`[ / ]`), end-of-timeline rewinds, driver recreations, `sceneResetSeq` resets, and async driver `onSeekSettled` events (`Html5MediaDriver` `seeked`, `YouTubeMediaDriver` paused state settle), driving immediate `evaluateTick60fps()` + `forceSyncUi()` synchronization while paused.
   - **Score Transition Reset vs. Live YAML Edit Continuity (`sceneResetSeq`)**: Opening, creating, forking, resetting, importing, or asynchronously hydrating a score increments `sceneResetSeq` in [`InteractiveStudioApp.tsx`](../src/ui/InteractiveStudioApp.tsx), triggering synchronous `useLayoutEffect` resets in [`useMediaClock.ts`](../src/hooks/useMediaClock.ts) (`pause()`, `seek(0)`) and [`useStageFrameLoop.ts`](../src/hooks/useStageFrameLoop.ts) (`resolveNextLoopSnapshotOnScoreSync` resetting `cameraMode` to `'scripted'` and evaluating frame `0`). Conversely, live YAML edits and in-place renames on the same `activeSceneId` keep `sceneResetSeq` unchanged and update driver duration via `setDuration()` without recreating the driver or losing the current timestamp `t` or paused orbit pose.
   - [`ObserverCameraRig`](../src/stage/ObserverCameraRig.tsx), [`StageCameraRig`](../src/stage/StageCameraRig.tsx), and [`DirectionalMannequin`](../src/stage/DirectionalMannequin.tsx) read `frameRef.current` inside their own `useFrame` hooks and mutate `THREE.Group` / `THREE.PerspectiveCamera` transforms directly in memory.
2. **Tier 2 — Throttled ~10Hz React UI Snapshot (`uiSnapshot`)**:
   - `setUiSnapshot` is throttled to fire at most once every `95ms` during continuous playback, or immediately whenever a shot boundary is crossed (`shotChanged`), an entity enters/exits an active blocking cue (`entityCueChanged`), playback pauses, the user scrubs/steps frames (`forceSyncUi()`), or camera POV mode is toggled.
   - **Live Free-Orbit Telemetry Sync (`notifyFreeOrbitChange`)**: When dragging `OrbitControls` in Free Orbit mode, telemetry updates are throttled at `80ms` and backed by an `85ms` trailing timer (`trailingSyncTimeoutRef`) guaranteeing the user's final resting mouse coordinates always flush reliably to React state. 1-click camera preset snaps bypass the throttle (`immediate = true`) to update coordinates instantaneously.

---

## 4. Transport Controls & Global Keyboard Shortcuts (`src/hooks/`)

Transport playback, frame-stepping, and diorama display modes are managed via [`useMediaClock.ts`](../src/hooks/useMediaClock.ts) and [`useStudioDisplaySettings.ts`](../src/hooks/useStudioDisplaySettings.ts). All single-key shortcuts include input element protection, safely deactivating whenever the user types inside an `<input>`, `<textarea>`, `<select>`, or `isContentEditable` element (such as CodeMirror 6 or search fields).

| Action | UI Control | Keyboard Shortcut | Behavior & Target Hook |
| :--- | :--- | :--- | :--- |
| **Play / Pause** | `[ ▶ / ❚❚ ]` Button | `Space` | Toggles active `MediaClockDriver` playback; restarts from `0.0s` if at end (`useMediaClock`). |
| **Restart to `00:00.00`** | `[ ↻ ]` Button | — | Seeks playhead back to `0.0s` (`useMediaClock`). |
| **Frame Step Back** | — *(Keyboard only)* | `[` | Pauses playback and seeks backward by $-\frac{1}{30}\text{s}$ (`-33.3ms`) (`useMediaClock`). |
| **Frame Step Forward** | — *(Keyboard only)* | `]` | Pauses playback and seeks forward by $+\frac{1}{30}\text{s}$ (`+33.3ms`) (`useMediaClock`). |
| **Skip $\pm 1\text{s}$ / $\pm 5\text{s}$** | Scrubber Bar | `ArrowLeft` / `ArrowRight` (`+Shift` for $5\text{s}$) | Seeks $\pm 1\text{s}$ (or $\pm 5\text{s}$ with `Shift`) and increments `lastManualSeekIdRef` (`useMediaClock`). |
| **Cycle 3D Labels** | Label Mode Toggle | `L` | Cycles diorama labels through `'all' -> 'camera-only' -> 'off' -> 'all'` (`useStudioDisplaySettings`). |
| **Toggle Safe Guides**| `[ Guides ]` Button | `G` | Toggles optical safe-action box, 3x3 grid, and center reticle in Stage Cam POV / Monitor (`useStudioDisplaySettings`). |
| **Toggle Optical DoF Blur** | `[ Blur ]` Button | `B` | Toggles real-time thin-lens depth of field bokeh blur in Stage Cam POV / Monitor (`useStudioDisplaySettings`). |
| **Loop Active Shot** | `[ 🔁 ]` Button | — | Dynamically bounds and loops playback within whichever shot is currently active (`activeShot.startSec` to `activeShot.endSec`), updating smoothly when jumping across shots without trapping manual seeks (`useStageFrameLoop`). |
| **Mute / Unmute Audio** | `[ 🔊 ]` Button | — | Toggles audio mute across HTML5 and YouTube drivers (`useMediaClock`). |
| **Playback Speed** | — *(Driver API)* | — | Adjusts `playbackRate` with display-time re-anchoring and no playhead jump; clamped to `0.1x`–`4x` on HTML5 and `0.25x`–`2x` on YouTube and Procedural drivers (`useMediaClock`). |
