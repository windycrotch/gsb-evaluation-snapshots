# API

This document outlines the core design principles behind the VisionPlayer API. It explains key methods and special behaviors in detail, and finally provides a consolidated overview of all core API calls.

## API Namespaces

While the core API of the Player class itself is directly available on the instance, APIs provided by component are typically using their own namespace. For example, the media API is available under the namespace `media` so media related functions use the signature `media.play`, `media.loop` etc. As the player API is dynamic and can be extended by any component, this minimises nameclashing and ensures better scalability and maintainability.

The VisionPlayer components use  the following namespaces:

- **player** - core player API (addComponent, setConfig)
- **player.consent** - optional consent gate for YouTube and Vimeo (off by default)
- **player.media** - all media‐related operations (load, play, pause…)
- **player.data** - loading and parsing of mediaData
- **player.dom** - Access to the players root element
- **player.ui** - UI‐control (show, hide, autoHide…)
- **player.audio** - audio operations (getAudioContext, add or remove audio nodes)

## Instance vs. Static API

The VisionPlayer API is divided into two categories:

### Instance API

- The majority of the VisionPlayer API  functions operate on a specific player instance.
- You call them on an instance you have created. Example:

```javascript
const vip = new VisionPlayer(...);
vip.getConfig('media');
vip.media.play();
vip.ui.show();
```

### Static API

- These functions are called directly on the Player class.

- They typically only have effect **before** creating new instances.

- They typically affect global player behavior, manage shared resources (such as global styles or locale data), or provide system-wide information. Example:

```javascript
Player.addComponent(...);
Player.setGlobalConfig(...);
```

Some data (like global style sheets or supported codecs) are also stored and managed centrally using static class members. This means changes apply to all player instances, not just one. If a function in the documentation starts with `Player`, it's part of the Static API. Otherwise, it belongs to the Instance API.

## Asynchronous API

Some core API methods (`media.load`, `setMediaData`, `setMediaIndex`) are designed as `async` functions and always return a Promise. While you can call them just like regular methods, it is recommended to handle them as any other `async` function, i.e. use `await`, `catch()` etc. They will return some payload if executed and also throw exceptions in case something goes wrong.

### Promise Reuse & Cancellation

If an asynchronous function is called repeatedly with the **same** arguments while a previous call is still pending, the previous call is not cancelled; instead, both calls resolve or reject identically with the same payload. However, if you call it with **different** arguments, the previous request is cancelled and its promise is rejected. Make sure to handle these cases correctly in your application logic.

### Examples

```javascript
// Start loading a video
const promise1 = player.media.load(( src: 'video.mp4' ));
// Another call with the same source while still pending
const promise2 = player.media.load(( src: 'video.mp4' ));
// -> Both promises resolve/reject identically with the same payload

// Cancellation example
const p1 = player.media.load(( src: 'video1.mp4' ));
const p2 = player.media.load(( src: 'video2.mp4' )); // cancels p1

p1.catch(e => (
    if (e.name === 'AbortError') (
        // Task was cancelled
    )
));
```

Always await or .catch() errors, including cancellations. If not handled, cancellation rejections will still propagate (and may show as uncaught Promise rejections).

## **Protected API Pattern with Symbols**

VisionPlayer applies a **protected API pattern** by leveraging ES2022 `Symbol`s.  This ensures certain internal methods remain inaccessible to external scripts or manual invocation from the browser console.

From a users perspective, some API methods which may return sensitive data or objects, or allow a userland script to extend or modify the player are **completely blocked** when the players `secureApi` config is enabled. Usage of this API is restricted to components which are - and should be! - the only ones receiving the players' secret API key. For more information about security, see [Security](./Security.md) regarding API access control and best practices.

From a components perspective, those methods have to be called with the apiKey provided by the player at instantiation. Regardless of other optional arguments, the `apiKey` is always the last one.

## Core API Overview

For more information about additional APIs from non-core  components, consult the [components documentation](Components.md).

### Player API

| Method                | Arguments                                                | Returns                        | Description                                              |
| --------------------- | -------------------------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| `getComponent`        | `componentPath` (String)<br>`apiKey` (Symbol)            | Component Class                | Returns a registered component by path, e.g., 'ui.scrubber'. Requires valid apiKey in secure mode. |
| `initConfig`          | `key` (String)<br>`defaults` (Object) = true             | Extended Config Value          | Initializes a config section; creates missing keys using defaults. |
| `getConfig`           | `searchPath` (String)                                    | Config Value                   | Gets the current config (full or fragment).              |
| `setConfig`           | `config` (Object)<br>`reinitialize` (Boolean)            | —                              | Extends config; optionally re-initializes the player.    |
| `getClient`           | `key` (String)                                           | Client Value                   | Returns client info (property by key or whole clone).    |
| `getState`            | `namespace` (String)                                     | State Value                    | Returns state (property by key or whole clone).          |
| `setState`            | `namespace` (String)<br>`descriptor` (Object)<br>[`apiKey`] (Symbol) | —                  | Adds a readonly state property; secure mode requires apiKey. |
| `removeState`         | `namespaces` (Array)<br>[`apiKey`] (Symbol)              | —                              | Remove one or more state properties; secure mode requires apiKey. |
| `setApi`              | `namespace` (String)<br>`method` (Function)<br>[`isPrivate`] (Boolean)<br>[`apiKey`] (Symbol) | — | Adds an instance API method (supports engine prefixes like `video:media.load`); secure mode requires apiKey. |
| `removeApi`           | `namespaces` (Array)<br>[`apiKey`] (Symbol)              | —                              | Removes instance API methods (supports engine prefixes); secure mode requires apiKey. |
| `addEngine`           | `engineId` (String)<br>`engine` (Object)<br>`config` (Object)<br>[`apiKey`] (Symbol) | — | Register a media engine with its capabilities. |
| `removeEngine`        | `engineId` (String)<br>[`apiKey`] (Symbol)               | —                              | Remove a registered engine.                              |
| `getEngine`           | [`engineId`] (String)<br>[`apiKey`] (Symbol)             | Object \| false                | Get current or specific engine entry.                    |
| `setEngine`           | `engineId` (String)<br>`options` (Object)<br>[`apiKey`] (Symbol) | Promise                   | Switch engine; disables old, enables new (options: `suspend`, `resume`, `params`). |
| `canPlay`             | `metaData` (Object)                                      | Object \| false                | Returns `{ engineId, canPlay }` from first matching engine. |
| `subscribe`           | `topic` (String)<br>`handler` (Function)<br>[`options`] (Object) | Subscribe Token (Number) | Subscribe to an internal event or topic.                 |
| `unsubscribe`         | `topicOrToken` (Boolean/String/Array)<br>`handler` (Function) | —                        | Unsubscribe from an event or token.                      |
| `publish`             | `topic` (String)<br>`data` (Object)<br>[`options`] (Object)<br>[`apiKey`] (Symbol) | — | Publish an event with optional payload; secure mode requires apiKey. |
| `destroy`             | —                                                        | —                              | Clean up and remove the player instance.                 |
| **Static API**            |                                                              |                                    |                                                              |
| `Player.addComponent`     | `path`&nbsp;(String)<br />`Component`&nbsp;(Function)<br />[`config`]&nbsp;(Object) |                                    | Register a new component at the given path.  The `Component` must be a valid class or factory function. `config` is an optional default configuration used by the component upon instantiation. Only available in non-secure builds (i.e. extensible mode). |
| `Player.setApi`           | `key`&nbsp;(String)<br />`method`&nbsp;(Function)            |                                    | Globally override or add a new player-wide API method named key. Only available before instantiating any players, and not in the secure build. |
| `Player.removeApi`        | `key`&nbsp;(String)                                          |                                    | Remove one or more global API methods before they are bound to any player instance. Not available in the secure build. |
| `Player.setDefaultConfig` | `config`&nbsp;(Object)                                       |                                    | Define a default configuration object that will be applied to all new player instances. Not available in the secure build. |
| `Player.getFormats`       |                                                              |                                    | Returns a cloned list of all supported media formats.        |
| `Player.addFormat`        | `format`&nbsp;(Object)                                       |                                    | Adds a new format definition to the global format registry.  |

### Data API

| Method                     | Arguments                                     | Returns                                                  | Description                                              |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `data.getMediaData`        | `selector` (String/Number)                    | Object                                                   | Returns item by index, full data (`all`), current stream (`current`) or active index (`index`). |
| `data.setMediaData`        | `mediaData` (Object/String)<br>`index` (Number) = 0 | Promise (parsed media data)                              | Assign media data; strings are auto-loaded as source or JSON. Rejects with DataError on parse failure. |
| `data.updateMediaData`     | `updateData` (Object)<br>`options` (Object)   | —                                                        | Merge updates into a media item (`options.index` default current; optional `options.property` for partial updates). Fires `data/update` for current item. |
| `data.setMediaIndex`       | `index` (Number)<br>`options` (Object) = {}   | Promise (media metadata)                                 | Switches to media at index, sets matching engine, loads it. If `options` omitted, uses current media state (volume/mute/seek/playbackRate/paused). |
| `data.getPreferredMetaData`| `options` (Object)<br>`media` (Object)        | Object or `false`                                        | Finds a playable source; respects preferred quality/language defaults; result includes `mediaEngine`/`mediaType` when available. |
| `data.error`               | `messageOrKey` (String)<br>`error` (Object)   | —                                                        | Emits a data/error event with the given message and optional error details. |

### Dom API

| Method            | Arguments                   | Returns | Description                                              |
| ------------------| --------------------------- | ------- | -------------------------------------------------------- |
| `dom.getElement`  | [`apiKey`] (Symbol)         | HTMLElement | Return the top-level DOM element where the player is rendered. Requires a valid `apiKey` in secure mode. |
| `dom.updateStyles`| `styles` (Array)            | —       | Update the player's style rules at runtime (mainly HMR). |
| **Static API** |                                 |             |                                                              |
| `Player.addStyles`    | `path`&nbsp;(String)<br/>`css`&nbsp;(String) |             | Adds a new CSS rule set loaded from the given path with the provided raw CSS text. Only available in development mode; not in secure builds. |
| `Player.updateStyles` | `styles`&nbsp;(Array)                |             | Global version of updateStyles. Replaces CSS of all components, based on an array of ( selector, rules ) objects, mainly for HMR support. |

### Media API

| Method                     | Arguments                                             | Returns                     | Description                                                                                                                        |
|----------------------------|-------------------------------------------------------|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| `media.load`               | `metaData` (Object) = {}<br>`options` (Object) = {}   | Promise (media metadata)    | Load a source; options include `rememberState`, `ignoreAutoplay`, `play`, `paused`, `seek`, `volume`, `muted`, `pictureInPicture`. |
| `media.getMetaData`        | —                                                     | Object                      | Returns the current source object.                                                                                                 |
| `media.canPlay`            | `mimeType` (String)<br>[`drmSystem`] (String)         | Boolean                     | Checks whether the environment can play a MIME type (and optional DRM).                                                            |
| `media.getElement`         | [`apiKey`] (Symbol)                                  | HTMLElement                 | Returns the underlying video element. Requires valid apiKey in secure mode.                                                        |
| `async media.play`         | —                                                     | Promise                     | Start or resume media playback (native play promise).                                                                              |
| `media.pause`              | —                                                     | —                           | Pause media playback.                                                                                                              |
| `media.loop`               | `doLoop` (Boolean)                                    | —                           | Enable/disable media looping.                                                                                                      |
| `media.playbackRate`       | `rate` (Number)                                       | —                           | Set playback speed.                                                                                                                |
| `media.seek`               | `position` (Number)                                   | —                           | Seek to the specified time in seconds.                                                                                             |
| `media.volume`             | `vol` (Number)                                        | —                           | Set the audio volume (0.0–1.0).                                                                                                    |
| `media.mute`               | `doMute` (Boolean)                                    | —                           | Mute or unmute audio.                                                                                                              |
| `media.requestPictureInPicture` | —                                               | Promise \| —                | Request Picture-in-Picture (if supported).                                                                                         |
| `media.exitPictureInPicture`    | —                                               | Promise \| —                | Exit Picture-in-Picture (if active/supported).                                                                                     |

### Locale API

| Method                | Arguments                                    | Returns | Description                                              |
| ------------------------- | ------------------------------------------------ | ----------- | ------------------------------------------------------------ |
| `locale.t`                | `path`&nbsp;(String)                             | String      | Returns the translated value based on the given key / path.  |
| `locale.getLocalizedTime`             | `timeArg`&nbsp;(Number)                          | String      | This method takes a time value in seconds and converts it to a human-readable format,  applying language-specific singular or plural forms for hours, minutes, and seconds, depending on the current locale. |
| `locale.getNativeLang`       | `lang`&nbsp;(String)                             | String      | Translates a language identifier (ISO 639-3 or legacy code) to its native language name. If no translation is available, the original language code is returned. |
| **Static API**            |                                                  |             |                                                              |
| `Player.addLocale`        | `translations`&nbsp;(Object)                     |             | Adds or merges a set of translation objects at runtime. The translations object should have corresponding language codes at the root level, e.g. ( "de": ( … ), "fr": ( … ) ). Not available in the secure build. |
| `Player.setDefaultLocale` | `lang`&nbsp;(String)                             |             | Sets the default locale for the player globally (before instantiation). |
| `Player.setLocaleConfig`  | `lang`&nbsp;(String)<br />`config`&nbsp;(Object) |             | Sets a config for a certain locale. Currently, specifying RTL languages (like Arabic) is supported, by using this config: ( rtl: true ). Not available in the secure build. |

### Consent API

The Consent component is disabled by default. When enabled, `player.consent` is available. `register` and `request` require the `apiKey` in secure mode; `setHandler` and `revoke` do not. Call `setHandler()` immediately after `new Player()`, in the same synchronous block.

| Method               | Arguments                                           | Returns           | Description |
| -------------------- | --------------------------------------------------- | ----------------- | ----------- |
| `consent.register`   | `id` (String)<br>`name` (String)<br>[`options`] (Object)<br>[`apiKey`] (Symbol) | — | Declares a service display name and optional overlay metadata (`thirdCountry`, `purposes`). Used by providers. `apiKey` stays last. |
| `consent.request`    | `id` (String)<br>[`apiKey`] (Symbol)                 | Promise (Boolean) | Awaits a consent decision. `true` allows the third-party load. |
| `consent.setHandler`  | `handler` (Function\|null)                          | —                 | External cookie-manager hook. Hides the player settings revoke row. Pass `null` to restore the internal overlay and settings row. |
| `consent.revoke`     | —                                                   | —                 | Deletes all stored grants. Does not unload an already playing provider. |

Events: `consent/required`, `consent/granted`, `consent/denied`. Full details: [Consent](../components/consent/Consent.md).

### UI API

| Method           | Arguments | Returns | Description                                              |
| -------------------- | ------------- | ----------- | ------------------------------------------------------------ |
| `ui.hide`            |               |             | Hide all player UI elements. Does not pause playback; just removes the UI layer from view. |
| `ui.show`            |               |             | Show the player UI if it was previously hidden.              |
| `ui.resize`          |               |             | Forces recalculation of player width and height and also fires the `ui/resize` event.              |
| `ui.disableAutoHide` |               |             | Disable the automatic UI hide feature. Normally, the UI hides after a short timeout when idle; this call prevents that behavior. |
| `ui.enableAutoHide`  |               |             | Re-enable the automatic UI hide after a period of inactivity. |

### Audio API

| Method         | Arguments                                                | Returns | Description                                              |
| ------------------ | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------ |
| `audio.getContext` | `apiKey`&nbsp;(Symbol)                                       |             | Provides the audio context of this component. This API is protected in secureApi mode. |
| `audio.addNode`    | `input`&nbsp;(AudioNode)<br />`output`&nbsp;(AudioNode)<br />[`order`] (Number)<br />`apiKey`&nbsp;(Symbol) |             | Inserts an audio node into the internal processing chain. This method expects the input and output (or null if no output is defined, as with analysers) of the processing chain to be inserted, and optionally an order value which determines when the inserted chain will be executed. This API is protected in secureApi mode. |
| `audio.removeNode` | `input`&nbsp;(AudioNode)<br />`output`&nbsp;(AudioNode)<br />`apiKey`&nbsp;(Symbol) |             | Removes a previously added audio node from the processing chain. This method expects the input and outputs of the processing chain to be removed from the 'master chain'. This API is protected in secureApi mode.|
