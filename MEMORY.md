# Memory

The first milestone uses a fixed 640×360 logical playfield and an orthographic Babylon camera. A single dynamic texture is updated from a 2D drawing context each frame; this keeps the game’s authored stepped geometry crisp while still using Babylon for the render surface.

The game uses only original in-code art because the image-generation quota was unavailable. The palette, character silhouette, and scene grammar are intentionally modular for later asset replacement.
