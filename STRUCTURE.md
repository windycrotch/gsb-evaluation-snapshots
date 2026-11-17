# Structure

```text
client/src/
  components/GameCanvas.tsx  React/Babylon lifecycle host and touch overlay
  game/
    types.ts                 semantic input, state, and entity types
    levelData.ts             authored stage layouts and entity placement
    GameWorld.ts              framework-agnostic physics, progression, and drawing
    scene.ts                  Babylon scene and dynamic texture bridge
  pages/Home.tsx             full-screen game route
  App.tsx                    route and theme shell
  index.css                  Signal Meadow global style tokens
```

Gameplay remains framework-agnostic. The only Babylon-specific boundary is `scene.ts`, and the only React-specific boundary is `GameCanvas.tsx`.
