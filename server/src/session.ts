/**
 * Playback session state — the one piece of mutable server state in ya-namp.
 *
 * A "session" is not the same thing as an account: it is the *current playback
 * context* (mode, account, current track) plus a monotonically increasing
 * `generation` that stamps every asynchronous result. Callers capture the
 * generation before awaiting an upstream call and drop the result if the
 * session moved on meanwhile. That is what keeps a slow token validation, a
 * slow stream resolution, or a late wave-feedback ping from rewriting a
 * session that has already moved on.
 *
 * Invariants:
 * - `generation` only ever increases; every accepted session transition bumps it.
 * - The mode is `yandex` exactly when a validated token is stored.
 * - A failed/superseded token submission never mutates the stored token, the
 *   account, the current track, or the generation.
 * - `authEpoch` changes only when a validated token is committed; it is what
 *   invalidates a stream resolved under different credentials.
 */
import type { PlaybackSnapshot, ServerMode } from '@shared';

export interface SessionAccount {
  login: string;
  uid: number;
}

export interface SessionAuth {
  token: string;
  uid: number;
}

/** Opaque token for one in-flight stream resolution. */
export interface StreamGuard {
  trackId: string;
  /** Auth epoch in force when the resolution started. */
  authEpoch: number;
}

export class PlaybackSession {
  private generationValue = 1;
  /** Bumped only on a token commit; identifies the credential set in force. */
  private authEpochValue = 0;
  private tokenValue: string | null = null;
  private accountValue: SessionAccount | null = null;
  private trackValue: string | null = null;
  /** The newest token submission. Older submissions must not commit. */
  private tokenAttempts = 0;
  /**
   * Whether the client has explicitly announced a track. Before that, a stream
   * request is the only signal available and may adopt the track (a bare
   * `<audio src>` client). After it, announcements are authoritative — a late
   * Range request for the *previous* track (the browser tearing down an old
   * src, or a seek that raced the switch) must not drag the session back.
   */
  private trackAnnounced = false;
  private readonly listeners = new Set<(generation: number) => void>();

  get generation(): number {
    return this.generationValue;
  }

  get mode(): ServerMode {
    return this.tokenValue ? 'yandex' : 'demo';
  }

  get currentTrackId(): string | null {
    return this.trackValue;
  }

  /** Stored credentials, or null in demo mode. */
  get auth(): SessionAuth | null {
    if (!this.tokenValue || !this.accountValue) return null;
    return { token: this.tokenValue, uid: this.accountValue.uid };
  }

  /** The account currently exposed over /api/status (never the token). */
  get account(): { login: string } | null {
    return this.accountValue ? { login: this.accountValue.login } : null;
  }

  snapshot(): PlaybackSnapshot {
    return {
      mode: this.mode,
      account: this.account,
      generation: this.generationValue,
      currentTrackId: this.trackValue,
    };
  }

  /** True when `generation` is still the current session. */
  isCurrent(generation: number): boolean {
    return generation === this.generationValue;
  }

  /**
   * Subscribes to session transitions. Listeners run synchronously after the
   * generation changes; used to abort in-flight upstream streams whose guard
   * just went stale. Returns an unsubscribe function.
   */
  onChange(listener: (generation: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bumpGeneration(): void {
    this.generationValue += 1;
    for (const listener of this.listeners) {
      try {
        listener(this.generationValue);
      } catch (err) {
        console.error(`[session] change listener failed: ${String(err)}`);
      }
    }
  }

  private moveTrack(trackId: string | null): void {
    if (this.trackValue === trackId) return;
    this.trackValue = trackId;
    this.bumpGeneration();
  }

  /**
   * Registers a token submission and returns its attempt id. A later
   * submission supersedes every earlier one, whether or not it succeeds.
   */
  beginTokenAttempt(): number {
    this.tokenAttempts += 1;
    return this.tokenAttempts;
  }

  /** True when `attempt` is the newest token submission. */
  isLatestTokenAttempt(attempt: number): boolean {
    return attempt === this.tokenAttempts;
  }

  /**
   * Applies a validated token, starting a new session (generation bump).
   *
   * The current track is preserved in the snapshot (a demo track keeps playing
   * across the switch), but the generation still moves on: any async result
   * started under the previous account — an in-flight stream resolution, a
   * late wave batch — is stale and must not be applied under the new account.
   *
   * Returns false (and changes nothing) when `attempt` has been superseded.
   */
  commitToken(attempt: number, token: string, account: SessionAccount): boolean {
    if (!this.isLatestTokenAttempt(attempt)) return false;
    this.tokenValue = token;
    this.accountValue = { login: account.login, uid: account.uid };
    this.authEpochValue += 1;
    this.bumpGeneration();
    return true;
  }

  /**
   * Records the track the client is now playing (the explicit announcement).
   * A different track is a new playback session; re-announcing the current
   * track (a seek, a duplicate notification) is a no-op and keeps the
   * generation stable so in-flight feedback remains valid.
   */
  setCurrentTrack(trackId: string | null): PlaybackSnapshot {
    this.trackAnnounced = true;
    this.moveTrack(trackId);
    return this.snapshot();
  }

  /**
   * Guards an async stream resolution.
   *
   * A stream request is the only signal a bare `<audio src>` client gives, so
   * before the client has announced any track, a request for a different track
   * adopts it (and bumps the generation). After the first announcement, only
   * announcements move the track — see `trackAnnounced`.
   *
   * Returns the guard the caller must re-check after awaiting upstream I/O: if
   * the session moved on meanwhile (another track, or a new account token), the
   * resolved stream is stale and must be dropped instead of proxied.
   */
  beginStream(trackId: string): StreamGuard {
    if (!this.trackAnnounced) this.moveTrack(trackId);
    return {
      trackId,
      authEpoch: this.authEpochValue,
    };
  }

  /**
   * Whether a resolved stream is still worth serving. The track must still be
   * the current one and no new account token may have been committed — the URL
   * was signed for the credentials in force when the resolution started.
   */
  isStreamCurrent(guard: StreamGuard): boolean {
    return guard.trackId === this.trackValue && guard.authEpoch === this.authEpochValue;
  }
}
