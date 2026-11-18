# ADR 002: Radio synced by the clock

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Deciders** | Yudi Ganeko |

## Context

Everyone in a room should hear the same second of the same song, and nobody controls it but the system (and an admin). The music comes from YouTube, which can't be streamed through our server.

## Decision

Each browser plays the video in an **embedded YouTube player with no controls** and follows **where it should be** according to the room's Durable Object, which is the shared clock.

- **The server sends the state.** On join (with or without an admin command), on every cut and whenever a duration is learned, the object sends `{ idx, sec, at }`: the track, the second inside it and the **server** time of that snapshot. The client measures its clock offset from `at` and does all position math on the server clock, so devices with a wrong local time still hear the same second.
- **Position = now − start.** Without a command, the start is a fixed date (2026-01-01) and the list loops. With a command, the start is the instant the admin pressed restart or skip, kept in the room object's storage.
- **Every 5 seconds the player corrects itself** if it drifted more than 3 s (ads, slow network).
- **Durations are learned** from the player as each video loads and reported to the room (`radio-duration`), which keeps them in storage so the state it computes matches what everyone hears; until then a video counts as one hour.
- **The admin sends `{ idx }` with the password**; the object stores `{ idx, at: now }` and broadcasts the resulting state to everyone, the sender included.
- **A click is required** ("enter the room"): browsers only play sound after a user gesture.
- **Pause is local**: it freezes your position (player and display). Resuming continues from the frozen point instead of jumping to the live second; the next state from the server re-syncs.
- **Late load callbacks are ignored**: a `PLAYING` event whose video id isn't the current track doesn't touch the title, the duration table or the progress bar.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Host the audio and stream it** | Rights to the music, bandwidth, a media server. |
| **The server sends "play at X" events** | Late joiners and drift still need the clock; events alone add nothing. |
| **Let anyone pick from the list** | The point is a shared radio, not a jukebox fight. |

## Consequences

- Sync is within a few seconds, good enough for background music.
- The player must stay visible (YouTube terms), so it's a small TV in the HUD.
- Videos with embedding disabled are skipped.
