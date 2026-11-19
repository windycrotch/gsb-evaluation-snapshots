---
"@canvas-tile-engine/core": minor
---

Add `LiveSpatialIndex`, a coordination layer that keeps a `SpatialIndex` synchronized with a live `ItemCollection`. The constructor indexes the collection's current items; every committed insert, update, and remove is then mirrored into the index synchronously, so bounding-box queries always reflect the latest geometry in the collection's draw order. Batched mutations refresh the index once when the outermost batch ends, rejected mutations never reach the index, and the idempotent `destroy()` detaches the subscription so later collection edits leave the index untouched.
