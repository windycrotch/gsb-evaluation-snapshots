# Bytebound mobile shell

The playable web project is responsive and installable as a fullscreen mobile web app through `client/public/manifest.json`. The game core is kept independent of React in `client/src/game/`, so a future Expo SDK 54 shell can reuse level data, semantic input actions, and persistence contracts without rewriting the rules.

The current WebDev project is intentionally browser-first: the same Babylon surface runs on desktop and mobile browsers, and the touch controls are designed for thumb reach and safe-area use. A true App Store or Play Store wrapper should be created as a separate Expo project once a native distribution target is confirmed; it should host the optimized game surface and map haptics/audio lifecycle events without duplicating gameplay logic.
