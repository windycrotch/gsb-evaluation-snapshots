# Asset Manifest

| Asset | Source | Role |
|---|---|---|
| Signal shard mark | Authored in SVG/CSS and canvas | Brand mark, favicon, HUD motif |
| Hero courier | Authored canvas sprite primitives | Player character |
| Shellbug | Authored canvas sprite primitives | Patrol enemy |
| Meadow tiles | Authored canvas rectangles and polygons | Collision terrain |
| Relay pennant | Authored canvas primitives | Checkpoint |
| Portal | Authored canvas primitives | Stage goal |
| Stepped hills and trees | Authored canvas parallax drawing | Background depth |
| HUD and touch controls | Authored HTML/CSS and canvas | Readability and mobile play |
| Meadow Run loop | Generated original instrumental track, `/manus-storage/bytebound-meadow-loop_fc44f82d.wav` | Looping background music |
| Jump, collect, stomp, checkpoint, hurt, finish cues | Authored Web Audio square/triangle/sawtooth tones | Short gameplay feedback sounds |

No external image files are currently referenced. The image-generation quota is exhausted; replace individual authored primitives with generated transparent assets later if desired, without changing the entity contracts. Audio uses one managed music file plus lightweight procedural cues so mobile playback stays responsive.
