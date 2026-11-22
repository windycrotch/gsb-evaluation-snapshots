# Microphone and playback lifecycle

## User interaction

AudioSession creates Web Audio resources lazily. Start playback or microphone capture from a user action so browser permission and autoplay rules can be satisfied. Microphone capture requires a secure context or localhost.

Capture is connected through a muted gain node. It does not feed live microphone audio audibly to the speakers, and volume changes while capturing never raise the monitor gain; switching back to playback restores the user's configured gain. Stop and close release owned tracks and disconnect nodes. Pause and resume control playback state; a completed source can be played again.

Every operation (play, microphone, pause, resume, stop, close) advances a session generation, so any operation still awaiting an async boundary is invalidated the moment a newer one begins. A stale continuation can neither overwrite the current state nor reconnect an audio source; any stream or source it acquired after losing the race is stopped and disconnected immediately. A denied or cancelled microphone request unwinds back to the idle state with no half-connected nodes, so capture can be retried. After close, every playback or microphone request rejects, repeated close calls are safe, and all tracks, sources, analyser and gain nodes are released.

Concurrent starts and stops use generation tracking so a late permission response cannot reactivate an old session. The demo disables offline frame navigation during live capture and restores recording labels afterward.

Live history is bounded to 128 frames and drawn at approximately ten updates per second. Time labels use observed animation timestamps, so rendering pauses do not invent a continuous capture cadence.
