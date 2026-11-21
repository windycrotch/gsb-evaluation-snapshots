# Engines

VisionPlayer now supports a pluggable multi-engine architecture. Engines are responsible for providing APIs, events and states for a given source. The player can host multiple engines in parallel and switch between them based on capability checks. In addition, engines also can be switched manually and support a "resume mode" for efficient handoffs.

## What is an engine?

An **engine** is a component that provides the media playback implementation for a specific backend or media source type. It acts as an abstraction layer between the player's unified `media.*` API and the underlying media technology, be it the native `<video>` element or any external provider, allowing the player to support multiple playback backends seamlessly.

### Engine Responsibilities

- **Implementing the media API surface**: It registers methods under the `media.*` namespace (e.g., `media.load`, `media.play`, `media.seek`) that translate player API calls into backend-specific operations.
- **Declaring capabilities**: It informs the player and other components about which features it supports (e.g., `play`, `seek`, `pictureInPicture`, `subtitles`) through a capability descriptor.
- **Managing lifecycle**: It provides `enable()` and `disable()` methods to handle activation and deactivation when switching between engines.
- **Publishing events**: It publishes events (e.g., `media/ready`, `media/play`, `media/pause`) to keep the player and UI components synchronized with playback state.
- **Handling media sources**: It implements a `canPlay()` method to determine if it can handle a given media source, enabling automatic engine selection, as well as a `media.load()` method.

### Benefits

- **Unified API**: All engines expose the same `media.*` API surface, so components and user code work consistently regardless of the active engine.
- **Runtime switching**: The player can switch between engines at runtime (e.g., from native video to Chromecast) without changing API calls.
- **Extensibility**: New backends can be added by implementing a new engine without modifying existing code.
- **Capability-aware UI**: Components can adapt their UI based on engine capabilities (e.g., hiding PiP controls when not supported).

### Built in engines

- **`default` engine**: Provides native HTML5 video/audio playback using the `<video>` element. Supports all standard browser media features including Picture-in-Picture, subtitles, and casting.
- **`youtube` engine**: Wraps the YouTube IFrame Player API to play YouTube videos. Supports playback, seeking, volume control, but not Picture-in-Picture (not supported by YouTube).
- **`vimeo` engine**: Integrates with the Vimeo Player API for Vimeo video playback. Supports most features including Picture-in-Picture.
- **`chromecast` engine**: Handles casting to Chromecast devices, translating player commands into Cast API calls. This engine is called manually and uses suspend / resume for seamless transitioning

## How it works

1. **Registration**: Engines register themselves with the player via `player.addEngine(engineId, engineInstance, { capabilities })` during component initialization. Each engine must provide a capability descriptor.
2. **Add Namespaced APIs**: Each engine registers its API methods with the engine ID prefix (e.g., `default:media.load`, `youtube:media.play`). However, **API calls are made without the prefix** — you call `media.play()`, not `default:media.play()`. The player automatically routes `media.*` calls to the current engine's namespaced implementation (e.g., `media.play()` → `default:media.play()` when the default engine is active).
3. **Capability probe**: When media data is ready and the optimal representation is selected, `player.canPlay({ src, mimeType })` queries each registered engine's `canPlay()` method in reverse registration order (newest first) until one returns `'probably'` or `'maybe'`. The method returns `{ engineId, canPlay }` or `false` if no engine can handle the media.
4. **Engine selection**: The Data component automatically selects the matching engine when switching media, or you can manually select an engine using `player.setEngine(engineId, options)`.
5. **Engine switching**: When an engine is selected, `player.setEngine()` calls `disable(options)` on the previous engine (if any), sets the new engine as current, and calls `enable(options)` on the new engine.
6. **Events**: In addition, engine switches emit `player/engine/set` (before switching) and `player/engine/switched` (after switching) events with from/to engine information and capabilities. By this way, any non-engine components also can react accordingly to engine switches.

### canPlay vs. manual switch

- **On Media Switching**: `player.canPlay(metaData)` asks engines in reverse registration order (newest first) and returns the first `{ engineId, canPlay }` with `'probably'` or `'maybe'`. This is the preferred path for automatic engine selection and will be executed automatically when switching media using the `data.setMediaIndex()` API.
- **Manually**: `player.setEngine(engineId, options)` forces a switch (e.g., user choice). For example this is used by the ChromeCast Component when handing over control back and forth. Use `options.params` to hand over state such as `seek`, `paused`, `playbackRate`, `volume`, `muted`.

## Capabilities

Engines declare capabilities when registering with the player. These capabilities inform other components about what features the engine supports, allowing them to adapt their UI accordingly. For example, the Picture-in-Picture control will be hidden if the current engine doesn't declare the `pictureInPicture` capability.

### Defined Capabilities

The following capabilities are currently defined in VisionPlayer:

| Capability          | Description                                                                                          |
|---------------------|------------------------------------------------------------------------------------------------------|
| `nativeVideoElement`| Indicates that the engine uses a native HTML5 `<video>` element. |
| `play`              | Engine supports play/pause functionality. Required for basic playback control.                        |
| `playbackRate`      | Engine supports changing playback speed. Required for playback rate controls.                       |
| `loop`              | Engine supports looping media. Required for loop controls.                                           |
| `seek`              | Engine supports seeking (requires both `duration` and `currentTime` support). Required for scrubber functionality. |
| `time`              | Engine supports time display (requires `duration` and/or `currentTime`). Required for time display components. |
| `volume`            | Engine supports volume control and muting. Required for volume controls.                            |
| `title`             | Engine can provide media title information. Required for title display components.                   |
| `subtitles`         | Engine supports subtitles.   |
| `cast`              | Engine supports casting to external devices (e.g., Chromecast, AirPlay). |
| `pictureInPicture` | Engine supports Picture-in-Picture mode (browser-dependent).                                        |
| `analyseVideo`      | Engine supports video analysis (for visualizers, filters, etc.). |
| `analyseAudio`      | Engine supports audio analysis (for visualizers, equalizers, etc.). |
| `filterVideo`       | Engine supports video filters (brightness, contrast, etc.).   |
| `filterAudio`       | Engine supports audio filters (equalizer, etc.).             |

**Note:** Not all engines support all capabilities. For example:

- The `default` engine supports all capabilities listed above.
- The `youtube` engine supports: `play`, `playbackRate`, `loop`, `seek`, `volume`, `time`.
- The `vimeo` engine supports: `play`, `playbackRate`, `loop`, `seek`, `volume`, `pictureInPicture`, `title`, `time`.
- The `chromecast` engine supports: `play`, `playbackRate`, `loop`, `seek`, `volume`, `title`, `time`.

## Suspend/Resume

`setEngine` supports the following options:

- `suspend: true` — the current engine is parked (not fully torn down) to allow fast reactivation.
- `resume: true` — the new engine may resume from a parked state.
- `params` — additional information that can be passed, like state payload for the new engine (seek, paused, playbackRate, volume, muted, etc.).

This is useful for flows like Chromecast handoff or future ad integrations where rapid toggling matters.

## Using engines

```js
// register engines (typically done inside engine constructors)
player.addEngine('myEngine', defaultEngine, { capabilities: { play: true, pictureInPicture: true } });

// direct switch (e.g., user choice)
await player.setEngine('myEngine', { suspend: true, resume: true });
```

### Player API (Engine Management)

| Method                | Arguments                                                      | Returns                    | Description                                                                                          |
|-----------------------|----------------------------------------------------------------|----------------------------|------------------------------------------------------------------------------------------------------|
| `addEngine`           | `engineId` (String)<br>`engine` (Object)<br>`config` (Object)<br>[`apiKey`] (Symbol) | —                          | Register a media engine with its capabilities. The `config` object must contain a `capabilities` property. |
| `removeEngine`        | `engineId` (String)<br>[`apiKey`] (Symbol)                    | —                          | Remove a registered engine.                                                                          |
| `getEngine`           | [`engineId`] (String)<br>[`apiKey`] (Symbol)                   | Object \| false            | Get current engine (if `engineId` omitted) or specific engine entry. Returns `false` if not found. |
| `setEngine`           | `engineId` (String)<br>`options` (Object)<br>[`apiKey`] (Symbol) | Promise                    | Switch to the specified engine. Options: `suspend` (Boolean), `resume` (Boolean), `params` (Object). |
| `canPlay`             | `metaData` (Object)                                            | Object \| false            | Returns `{ engineId, canPlay }` from first matching engine, or `false` if none can play.            |

### Engine Requirements

When implementing a custom engine, you must implement the following **management methods** for proper integration with the player:

1. **Implement lifecycle methods**: Provide `enable()` and `disable()` methods to manage the engine lifecycle when switching. These are called by the player when engines are activated or deactivated.
2. **Implement `canPlay(metaData)`** (optional, but recommended): If you want automatic engine selection, implement this method. Must return `'probably'`, `'maybe'`, or `''` (empty string) to indicate if the engine can handle the given media data.
3. **Register media API methods**: Register your engine's media API methods using `player.setApi()` with the engine namespace prefix (e.g., `myengine:media.load`). The specific methods you register are entirely up to you — there are no fixed requirements for the media API surface, except for `media/load`and `media/getMetaData`.
4. **Publish events**: Publish media events through the player using `player.publish()` if applicable. (e.g., `media/ready`, `media/play`, `media/pause`, etc.) to keep the player and other components informed about the engine's state.
5. **Handle State**: Engine needs to setup and tear down its state accordingly using `player.setState` and `player.removeState`
6. **Handle suspend/resume** (optional): If applicable, implement suspend/resume logic for faster reactivation when `options.suspend` or `options.resume` are true.

### Engine API Methods

**Engines define their own media API surface** — there is no fixed set of required media API methods, except for `media/load`and `media/getMetaData`. Each engine registers only the API methods it supports, which typically correspond to its declared capabilities. This flexibility allows engines to:

- Offer a **subset** of common methods (e.g., YouTube engine doesn't support Picture-in-Picture APIs)
- Provide **engine-specific** methods beyond the standard media API
- Adapt their API to match their backend's capabilities

#### Example

```javascript
// Register API methods with engine prefix during initialization
this.#player.setApi('myengine:media.load', this.#load, this.#apiKey);
this.#player.setApi('myengine:media.play', this.#play, this.#apiKey);
// ... etc
```

**Important:** Even though methods are registered with the `myengine:` prefix, they are called without it:

```javascript
await player.media.load(metaData); // User code - no prefix needed!
player.media.play();

// The player automatically routes these calls to:
// - myengine:media.load (when myengine is active)
// - myengine:media.play (when myengine is active)
// - myengine:media.requestPictureInPicture (when myengine is active)
```

#### Common API Methods

While mostly not required, most engines implement some of these common methods under the `{engineId}:media.*` namespace:

| Method                          | Typical Usage | Notes                                                                                          |
|---------------------------------|---------------|------------------------------------------------------------------------------------------------|
| `{engineId}:media.load`         | Required      | Load a media source. Accepts `metaData` (Object) and `options` (Object), returns Promise.     |
| `{engineId}:media.getMetaData`  | Required      | Return the current source metadata object.                                                    |
| `{engineId}:media.getElement`   | Recommended   | Return the underlying media element (e.g., `<video>`, `<iframe>`). Recommended for compatibility. |
| `{engineId}:media.play`         | Common        | Start playback. Usually required if `play` capability is declared.                            |
| `{engineId}:media.pause`        | Common        | Pause playback. Usually required if `play` capability is declared.                            |
| `{engineId}:media.seek`         | Common        | Seek to the specified time in seconds. Typically provided if `seek` capability is declared.   |
| `{engineId}:media.volume`       | Common        | Set volume 0..1. Typically provided if `volume` capability is declared.                       |
| `{engineId}:media.mute`         | Common        | Toggle mute state. Typically provided if `volume` capability is declared.                    |
| `{engineId}:media.loop`         | Optional      | Enable/disable looping. Typically provided if `loop` capability is declared.                  |
| `{engineId}:media.playbackRate` | Optional      | Set playback speed. Typically provided if `playbackRate` capability is declared.             |

### Switching Events

The player publishes the following events when engines are switched:

| Event Name            | Payload                                                      | Description                                                                                          |
|-----------------------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `player/engine/set`   | `from` (Object)<br>`to` (Object)<br>`options` (Object)      | Emitted **before** switching engines. `from` and `to` contain `id` and `capabilities`. `options` contains `suspend`, `resume`, and `params`. |
| `player/engine/switched` | `from` (Object)<br>`to` (Object)<br>`options` (Object)    | Emitted **after** switching engines. Same payload shape as `player/engine/set`.                     |

**Example Event Payload:**

```javascript
{
    from: { // switch from chromecast ....
        id: 'chromecast',
        capabilities: { play: true, ... }
    },
    to: { // ... to the default engine
        id: 'default',
        capabilities: { play: true, ... }
    },
    options: {
        suspend: true,        // Chromecast should be suspended
        resume: true,         // Default engine should be resumed
        params: {             // State parameters passed to new engine, to reflect changes that occured while casting
            seek: 30,         // Seek to new position etc.
            paused: false,
            playbackRate: 1
        }
    }
}
```
