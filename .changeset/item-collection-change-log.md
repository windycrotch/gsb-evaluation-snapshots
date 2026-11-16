---
"@canvas-tile-engine/core": minor
"@canvas-tile-engine/react": minor
"@canvas-tile-engine/react-native": minor
---

Add `ItemCollection.changesSince(sequence)` to replay applied changes from a cursor, returning the ordered change records after that sequence plus the latest sequence. Add `ItemCollection.replaceAll(items)` to validate, then replace every item in one batch notification while keeping the backing array identity. Both are exported through the React and React Native bindings, including the new `ItemCollectionChanges<T>` type.
