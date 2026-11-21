# Consent

The Consent component is an opt-in gate for third-party providers that contact an external host without a prior user action. In the current player that is YouTube and Vimeo: both load a script (`youtube.com/iframe_api` / `player.vimeo.com/api/player.js`) and embed a third-party iframe as soon as matching media is selected.

**Note: This component is disabled by default and has to be explicitly enabled via** `playerConfig`**.**

When enabled, the player pauses those loads until consent is granted. If an external handler is registered via `setHandler()`, that handler decides and the player settings row is hidden. Otherwise the component shows a blocking overlay, including a privacy-policy link that includes the provider name. The overlay focuses the dialog, not Agree or Decline, so neither choice is the default action. Granted decisions are stored in Web Storage. A settings-menu row can revoke all stored grants; it does not unload a provider that is already playing.

This is a technical mechanism, not a legal assessment of any particular site. The overlay links to the provider's own privacy policy because the player cannot describe that provider's processing. The embedding site remains the controller and still needs its own notice. Default URLs can go stale; override them in config when they change.

## Configuration

Configuration example with defaults (when enabled with `consent: true`):

```javascript
const playerConfig = {
    consent: {
        storage: 'local',
        storageKey: 'vip-consent',
        expires: 180,
        privacyUrls: {
            youtube: 'https://policies.google.com/privacy',
            vimeo: 'https://vimeo.com/privacy'
        }
    }
};
```

`consent: true` turns the component on with those defaults. `consent: { expires: 1 }` merges with the defaults. Omit the section, or set `consent: false`, to leave the component off.


| Setting Name  | Type   | Description                                                                                                                                                                                                                                            |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`     | String | Where granted decisions are stored: `'local'` (`localStorage`), `'session'` (`sessionStorage`), or `'none'` (runtime only).                                                                                                                            |
| `storageKey`  | String | Key used in Web Storage.                                                                                                                                                                                                                               |
| `expires`     | Number | Lifetime of a stored grant, in days. Expired entries are discarded on read.                                                                                                                                                                            |
| `privacyUrls` | Object | Privacy-policy URLs keyed by service id. Defaults point at Google (YouTube) and Vimeo's privacy pages. Override a key, or set it to `false` / `''`, to hide that overlay link. Relative paths starting with `/` are resolved against the current page. |


Only grants are stored. A denial is not persisted, so the overlay can be shown again without clearing storage.

## API

`register` and `request` require the player `apiKey` when `secureApi` is on. `setHandler` and `revoke` do not, so an external cookie manager or a site-level revoke control can still attach.


| Method               | Arguments                                                                 | Returns           | Description                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consent.register`   | `id` (String), `name` (String), [`options`] (Object), [`apiKey`] (Symbol) | —                 | Declares a service display name and optional overlay metadata (`thirdCountry`, `purposes`). Called by providers in their constructor. The third argument may be omitted; `apiKey` stays last. |
| `consent.request`    | `id` (String), [`apiKey`] (Symbol)                                        | Promise (Boolean) | Waits for a decision. Returns `true` only when loading is allowed. Unknown ids still require consent; the overlay falls back to the id as the name.                                           |
| `consent.setHandler` | `handler` (Function|null)                                                 | —                 | Registers an external decider. `handler({ id, name })` may return a boolean or a Promise. `setHandler(null)` restores the internal overlay/storage path and the settings revoke row.          |
| `consent.revoke`     | —                                                                         | —                 | Deletes the entire consent store (the configured `storageKey`, or the in-memory map). Does not unload a playing YouTube/Vimeo iframe. Does not require an `apiKey`.                           |


Call `setHandler()` in the same synchronous block as `new Player()`. `request()` is only reached after at least one `await` in media loading, but if the handler is attached later an internal overlay may already have appeared.

There is also `consent.revoke()` to forget stored grants from the settings menu or from userland. To wipe storage manually:

```javascript
localStorage.removeItem('vip-consent');
```



## Events


| Event Name         | Payload        | Description                                                                         |
| ------------------ | -------------- | ----------------------------------------------------------------------------------- |
| `consent/required` | `{ id, name }` | A service is about to ask for consent.                                              |
| `consent/granted`  | `{ id, name }` | Consent was granted.                                                                |
| `consent/denied`   | `{ id, name }` | Consent was denied. The component also publishes a consent-specific `notification`. |




## What is not gated

These cases stay outside the gate on purpose:

- **Chromecast** — the Cast SDK is loaded after a click on the Cast button (`chromeCast.lazyLoadLib: true` by default). Setting `lazyLoadLib: false` removes that two-click property and loads gstatic without interaction. Reloading a tab with `sessionStorage['vip-chrome-cast-active']` also loads Cast without a new click; that key is only written after an active session and dies with the tab.
- **hls.js / dash.js** — those are code downloads. The IP sent to the CDN can be avoided by pointing `hls.libUrl` / `dash.libUrl` at a self-hosted copy.
- **DRM license and certificate servers** — URLs come from the publisher's media metadata and are required to play that item.

