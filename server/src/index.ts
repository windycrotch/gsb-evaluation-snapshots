/**
 * ya-namp server: demo mode (procedural in-memory WAVs) by default,
 * Yandex Music proxy mode once a valid OAuth token is posted to /api/token.
 * API contract: /shared/types.ts
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApiError,
  BitrateResponse,
  CreatePlaylistRequest,
  LikedIdsResponse,
  LikeRequest,
  LikeResponse,
  PlaylistsResponse,
  PlaylistSummary,
  PlaylistTracksResponse,
  SearchResponse,
  StatusResponse,
  TokenRequest,
  TokenResponse,
  WaveFeedbackRequest,
  WaveResponse,
} from '@shared';
import {
  demoPlaylists,
  demoPlaylistTracks,
  getDemoEntry,
  searchDemoTracks,
  simulatedWave,
} from './demo';
import {
  UpstreamError,
  addToPlaylist,
  createPlaylist,
  errorMessage,
  fetchLikedIds,
  getBitrate,
  fetchPlaylists,
  fetchPlaylistTracks,
  fetchWave,
  likeTrack,
  resolveStreamUrl,
  searchTracks,
  sendWaveFeedback,
  validateToken,
} from './yandex';
import { proxyStream, serveBufferWithRange } from './stream';

const app = express();
app.disable('x-powered-by');

/** In-memory session. null → demo mode; set → yandex mode. */
let session: { token: string; login: string; uid: number } | null = null;

// ---------------------------------------------------------------------------
// CORS for all /api routes (permissive: the vite dev client may call us
// directly from http://localhost:5173, or via its proxy).
// ---------------------------------------------------------------------------
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use('/api', express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/status', (_req: Request, res: Response) => {
  const body: StatusResponse = session
    ? { mode: 'yandex', account: { login: session.login } }
    : { mode: 'demo', account: null };
  res.json(body);
});

app.post('/api/token', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<TokenRequest> | undefined;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Missing "token" in request body' } satisfies ApiError);
      return;
    }
    const account = await validateToken(token);
    if (!account) {
      res.status(401).json({ error: 'Invalid Yandex Music token' } satisfies ApiError);
      return;
    }
    session = { token, login: account.login, uid: account.uid };
    console.log(`[auth] yandex mode enabled for account "${account.login}"`);
    res.json({ ok: true, account: { login: account.login } } satisfies TokenResponse);
  } catch (err) {
    respondError(res, err, 'Token validation failed');
  }
});

app.get('/api/search', async (req: Request, res: Response) => {
  const rawQ = req.query.q;
  const q = typeof rawQ === 'string' ? rawQ : Array.isArray(rawQ) && typeof rawQ[0] === 'string' ? rawQ[0] : '';
  if (!session) {
    res.json({ tracks: searchDemoTracks(q) } satisfies SearchResponse);
    return;
  }
  if (!q.trim()) {
    // Contract: yandex mode returns [] for an empty query.
    res.json({ tracks: [] } satisfies SearchResponse);
    return;
  }
  try {
    const tracks = await searchTracks(session.token, q);
    res.json({ tracks } satisfies SearchResponse);
  } catch (err) {
    respondError(res, err, 'Search failed');
  }
});

app.get('/api/bitrate/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const demo = getDemoEntry(id);
  if (demo) {
    res.json({ kbps: demo.track.bitrateKbps } satisfies BitrateResponse);
    return;
  }
  if (!session) {
    res.json({ kbps: null } satisfies BitrateResponse);
    return;
  }
  const kbps = await getBitrate(session.token, id);
  res.json({ kbps } satisfies BitrateResponse);
});

app.get('/api/wave', async (req: Request, res: Response) => {
  const rawAfter = req.query.after;
  const after = typeof rawAfter === 'string' && rawAfter ? rawAfter : undefined;
  if (!session) {
    res.json({ tracks: simulatedWave(after), sessionId: 'demo-wave' } satisfies WaveResponse);
    return;
  }
  try {
    const batch = await fetchWave(session.token, after);
    res.json(batch satisfies WaveResponse);
  } catch (err) {
    respondError(res, err, 'My Wave failed');
  }
});

app.post('/api/wave/feedback', async (req: Request, res: Response) => {
  const body = req.body as Partial<WaveFeedbackRequest> | undefined;
  const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
  const event = body?.event;
  if (!trackId || (event !== 'trackStarted' && event !== 'trackFinished' && event !== 'skip')) {
    res.status(400).json({ error: 'Invalid wave feedback payload' } satisfies ApiError);
    return;
  }
  // Best-effort: demo mode is a no-op, and yandex feedback never fails the client.
  if (session) {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    void sendWaveFeedback(session.token, event, trackId, sessionId, body?.totalPlayedSeconds);
  }
  res.status(204).end();
});

app.get('/api/stream/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;

  // Demo tracks stream from memory regardless of mode, so a playlist built
  // in demo mode keeps playing after a token is set.
  const demo = getDemoEntry(id);
  if (demo) {
    serveBufferWithRange(req, res, demo.wav, 'audio/wav');
    return;
  }
  if (!session) {
    res.status(404).json({ error: `Unknown track id: ${id}` } satisfies ApiError);
    return;
  }
  try {
    const url = await resolveStreamUrl(session.token, id);
    await proxyStream(req, res, url);
  } catch (err) {
    if (res.headersSent) {
      // Body already streaming — nothing sensible to send; log and cut off.
      console.error(`[stream] ${id} aborted mid-stream: ${errorMessage(err)}`);
      res.destroy();
      return;
    }
    respondError(res, err, 'Stream failed');
  }
});

app.get('/api/playlists', async (_req: Request, res: Response) => {
  if (!session) {
    res.json({ playlists: demoPlaylists() } satisfies PlaylistsResponse);
    return;
  }
  try {
    const playlists = await fetchPlaylists(session.token, session.uid);
    res.json({ playlists } satisfies PlaylistsResponse);
  } catch (err) {
    respondError(res, err, 'Playlists failed');
  }
});

app.get('/api/playlists/:id/tracks', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!session) {
    const tracks = demoPlaylistTracks(id);
    if (!tracks) {
      res.status(404).json({ error: `Unknown playlist id: ${id}` } satisfies ApiError);
      return;
    }
    res.json({ tracks } satisfies PlaylistTracksResponse);
    return;
  }
  try {
    const tracks = await fetchPlaylistTracks(session.token, session.uid, id);
    res.json({ tracks } satisfies PlaylistTracksResponse);
  } catch (err) {
    respondError(res, err, 'Playlist tracks failed');
  }
});

app.get('/api/liked-ids', async (_req: Request, res: Response) => {
  if (!session) {
    res.json({ ids: [] } satisfies LikedIdsResponse);
    return;
  }
  try {
    const ids = await fetchLikedIds(session.token, session.uid);
    res.json({ ids } satisfies LikedIdsResponse);
  } catch (err) {
    respondError(res, err, 'Liked ids failed');
  }
});

app.post('/api/like', async (req: Request, res: Response) => {
  const body = req.body as Partial<LikeRequest> | undefined;
  const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
  const liked = body?.liked;
  if (!trackId || typeof liked !== 'boolean') {
    res.status(400).json({ error: 'Invalid like payload' } satisfies ApiError);
    return;
  }
  if (!session) {
    // Demo mode: no account to like against — echo the requested state.
    res.json({ liked } satisfies LikeResponse);
    return;
  }
  try {
    await likeTrack(session.token, session.uid, trackId, liked);
    res.json({ liked } satisfies LikeResponse);
  } catch (err) {
    respondError(res, err, 'Like failed');
  }
});

app.post('/api/playlists/create', async (req: Request, res: Response) => {
  const body = req.body as Partial<CreatePlaylistRequest> | undefined;
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const trackIds = Array.isArray(body?.trackIds)
    ? body.trackIds.filter((t): t is string => typeof t === 'string')
    : undefined;
  if (!title) {
    res.status(400).json({ error: 'A playlist title is required' } satisfies ApiError);
    return;
  }
  if (!session) {
    res
      .status(409)
      .json({ error: 'Connect a Yandex account to create playlists' } satisfies ApiError);
    return;
  }
  try {
    const playlist: PlaylistSummary = await createPlaylist(session.token, session.uid, title, trackIds);
    res.json(playlist satisfies PlaylistSummary);
  } catch (err) {
    respondError(res, err, 'Create playlist failed');
  }
});

app.post('/api/playlists/:id/add', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const body = req.body as Partial<{ trackIds: unknown }> | undefined;
  const trackIds = Array.isArray(body?.trackIds)
    ? body.trackIds.filter((t): t is string => typeof t === 'string')
    : [];
  if (trackIds.length === 0) {
    res.status(400).json({ error: 'trackIds required' } satisfies ApiError);
    return;
  }
  if (id === 'liked') {
    res.status(400).json({ error: 'Use the heart to like tracks' } satisfies ApiError);
    return;
  }
  if (!session) {
    res
      .status(409)
      .json({ error: 'Connect a Yandex account to edit playlists' } satisfies ApiError);
    return;
  }
  try {
    const playlist: PlaylistSummary = await addToPlaylist(session.token, session.uid, id, trackIds);
    res.json(playlist satisfies PlaylistSummary);
  } catch (err) {
    respondError(res, err, 'Add to playlist failed');
  }
});

// Unknown /api routes → JSON 404 (never the SPA fallback).
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' } satisfies ApiError);
});

// ---------------------------------------------------------------------------
// Static client (production) + SPA fallback
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[static] serving client from ${clientDist}`);
} else {
  console.log(`[static] ${clientDist} not found — API only (run the vite dev client separately)`);
}

// Final JSON error handler (e.g. malformed JSON body).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[error] ${errorMessage(err)}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status =
    err instanceof UpstreamError
      ? err.status
      : typeof (err as { status?: unknown }).status === 'number'
        ? ((err as { status: number }).status)
        : 500;
  res.status(status).json({ error: errorMessage(err) } satisfies ApiError);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondError(res: Response, err: unknown, context: string): void {
  const status = err instanceof UpstreamError ? err.status : 502;
  const message = `${context}: ${errorMessage(err)}`;
  console.error(`[error] ${message}`);
  res.status(status).json({ error: message } satisfies ApiError);
}

// ---------------------------------------------------------------------------
// Optional .env token: boot straight into yandex mode for a local real-account
// demo. The token is supplied by the user (see scripts/set-token.mjs); it is
// never logged. An invalid/expired token just falls back to demo mode.
// ---------------------------------------------------------------------------
function readEnvToken(): string | null {
  const fromEnv = process.env.YANDEX_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envPath = path.resolve(__dirname, '../../.env');
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null; // no .env file — expected in demo-only setups
  }
  for (const line of text.split('\n')) {
    const m = /^\s*YANDEX_TOKEN\s*=\s*(.*)\s*$/.exec(line);
    if (m) {
      const raw = (m[1] as string).trim();
      return raw.replace(/^["']|["']$/g, '') || null;
    }
  }
  return null;
}

async function bootstrapSession(): Promise<void> {
  const token = readEnvToken();
  if (!token) return;
  try {
    const account = await validateToken(token);
    if (account) {
      session = { token, login: account.login, uid: account.uid };
      console.log(`[auth] .env token accepted — yandex mode for "${account.login}"`);
    } else {
      console.warn('[auth] .env YANDEX_TOKEN was rejected (expired?) — staying in demo mode');
    }
  } catch (err) {
    console.warn(`[auth] could not validate .env token: ${errorMessage(err)} — staying in demo mode`);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT) || 8058;
void bootstrapSession().finally(() => {
  app.listen(port, () => {
    const mode = session ? `yandex (${session.login})` : 'demo';
    console.log(`[ya-namp] server listening on http://localhost:${port} (mode: ${mode})`);
  });
});
