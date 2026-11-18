# AeroFlap Customization Contract

## Product Scope

The Customization Studio lets a player replace the default visual and audio mood of a flight while keeping the collision model and core control scheme intact. Settings apply immediately in the current browser session. Signed-in players can save a profile and rehydrate it on later sessions.

## Settings Model

| Group | Setting | Range or format | Game behavior |
| --- | --- | --- | --- |
| Appearance | Accent color | Hex color | Changes primary action and player fallback color. |
| Appearance | Gate color | Hex color | Changes newly spawned sky gates. |
| Appearance | Background mode | Default, image, or video | Selects the art-directed default, a custom image, or a muted looping video layer. |
| Flight | Pace | `0.75` to `1.35` | Multiplies obstacle movement speed. |
| Flight | Gate opening | `0.80` to `1.20` | Multiplies the obstacle gap while preserving a safe minimum. |
| Audio | Master volume | `0` to `1` | Controls custom ambient and flap sound playback. |
| Audio | Muted | Boolean | Stops all custom audio playback. |
| Media | Aircraft image | Stored image asset | Replaces the procedural player fallback with player artwork when loaded. |
| Media | Background image | Stored image asset | Used when background mode is image. |
| Media | Background video | Stored video asset | Used when background mode is video. |
| Media | Ambient track | Stored audio asset | Loops after a player interaction. |
| Media | Flap sound | Stored audio asset | Plays when the player takes a lift action. |

## Persistence and Safety

Asset bytes are stored in project storage. The database stores each asset’s immutable key, user ownership, MIME type, display name, and slot. The customization profile stores only a validated JSON settings record and references the user-owned asset slots. Uploads are limited by file class to keep browser and server memory predictable: images are limited to 5 MB, audio to 8 MB, and video to 12 MB.

## Interaction Model

The studio opens from a compact control in the flight deck and remains a transient overlay rather than replacing gameplay. Changes preview immediately. The reset action restores the project defaults. Saving requires sign-in because the profile and its asset references are tied to the authenticated user; unsigned players can still test a session-local draft.

## Validation Status

| Check | Result |
| --- | --- |
| Typecheck, production build, and test suite | Passed. The automated suite covers media-slot validation, protected upload handoff, and saved-profile loading and saving contracts. |
| Keyboard controls | Passed in browser-level checks for opening, closing, switching background modes, and focusing and activating all five imported-media triggers. Each input exposes visible focus treatment. |
| Desktop and mobile layout | Passed visual checks for the default flight deck and expanded studio panel. |
| Native file chooser selection | Deferred with the project owner’s approval because the automated browser does not deliver an OS file-selection event. The application validates the selected file on the client, previews it immediately, and persists it only after authenticated upload. |
