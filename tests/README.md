# Test Suite

The tests run on Node.js 18+ (built-in `node:test`, no third-party
dependencies and no browser required).

```console
npm test
# or directly:
node --test tests/*.test.js
```

## Files

| File | What it covers |
| --- | --- |
| `recent-store.test.js` | Pure unit tests for the source-based identity rules in `recent-store.js` |
| `script.test.js` | Integration tests that load `script.js` in a minimal DOM stub and drive it through real UI events |
| `service-worker.test.js` | Service-worker lifecycle tests using Cache/Clients stubs inside a `vm` sandbox |
| `browser-env.js` | Shared minimal browser stubs (DOM, localStorage, ObjectURL registry, Swal, ServiceWorker) |

## Acceptance scenarios — trigger and expected result

### 1. Normal source switch and resume (`script.test.js`)
- **Trigger:** play URL `a.mp4`, let it reach 50%, then play `b.mp4`,
  then play `a.mp4` again and fire `loadedmetadata`.
- **Expected:** two separate records exist; `a.mp4` keeps 50% while
  `b.mp4` stays at 0%; reopening `a.mp4` restores the player to 50%.

### 2. Same title, different source (`recent-store.test.js`, `script.test.js`)
- **Trigger:** play `https://host1/clip.mp4` then `https://host2/clip.mp4`
  (identical file name, different hosts).
- **Expected:** two records coexist; progress written while playing one
  never lands on the other; deleting one leaves the other intact.

### 3. Local-file identity (`recent-store.test.js`)
- **Trigger:** save a local entry, then save the same file name again with
  a different `blob:` URL (as happens when the file is reselected later).
- **Expected:** a single record, refreshed to the new URL, with the
  previously saved progress retained.

### 4. ObjectURL lifecycle (`script.test.js`)
- **Trigger:** play local videos A → A again → B → a remote URL, including
  local subtitle ObjectURLs, and finally fire `pagehide`.
- **Expected:** the previous ObjectURL is revoked only after the player
  detaches it; replaying the same URL never revokes it; the currently
  referenced URL is always alive; `pagehide` releases everything left.

### 5. Import with duplicates (`recent-store.test.js`, `script.test.js`)
- **Trigger:** import a backup containing two records with the same
  source identity (same URL, or same local file name).
- **Expected:** the import is rejected with the error dialog and the
  previously stored list is byte-for-byte unchanged.

### 6. Import with an over-long list (`recent-store.test.js`, `script.test.js`)
- **Trigger:** import a valid backup containing 35 (or 40) unique records.
- **Expected:** import succeeds and the stored list is truncated to the
  30-entry limit, keeping the first 30 entries of the backup.

### 7. Import of an illegal file (`recent-store.test.js`, `script.test.js`)
- **Trigger:** import non-JSON text, a JSON object that is not an array,
  or an array containing a record with an invalid field
  (wrong type, progress outside 0–100, unknown `videoType`).
- **Expected:** every payload is rejected; the existing list is never
  modified and the file input is reset.

### 8. Offline navigation (`service-worker.test.js`)
- **Trigger:** after install, make `fetch` reject (simulated offline) and
  dispatch a `navigate` request.
- **Expected:** the response resolves to the cached `index.html`
  homepage instead of failing.

### 9. Online navigation refreshes the cache (`service-worker.test.js`)
- **Trigger:** dispatch a `navigate` request while `fetch` succeeds.
- **Expected:** the network response is returned and a copy is stored
  under `index.html` so the next offline navigation has a fresh fallback.

### 10. Cache version upgrade (`service-worker.test.js`)
- **Trigger:** pre-populate `neovid-v1.3` and `neovid-v1.4` caches, run
  install of the current worker (`neovid-v1.5`), then activate.
- **Expected:** both old caches are deleted during activation, the v1.5
  cache is preserved, and `clients.claim()` runs exactly once.

### 11. Single reload after a confirmed update (`script.test.js`)
- **Trigger:** simulate two `statechange` notifications for a waiting
  worker, confirm the prompt once, then fire two `controllerchange`
  events.
- **Expected:** only one confirmation dialog is opened, one
  `SKIP_WAITING` message is posted, and the page reloads exactly once.

### 12. Local entry no longer fails silently (`script.test.js`)
- **Trigger:** click a local record in the rendered recent list.
- **Expected:** the form switches to Local File mode, the file picker is
  opened and the reselect notice is shown; no stale `blob:` URL is
  submitted to the player.
