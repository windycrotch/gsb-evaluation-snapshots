import { purpose, type Database, type VideoMediaStage } from '@openreel/db'
import { sql, type Kysely } from 'kysely'

export interface Job {
  authorDid: string
  videoCid: string
  attempts: number
}

/** How long a claimed job may run before another worker assumes it died. */
const STALE_CLAIM = sql`interval '15 minutes'`

/**
 * Claims the oldest runnable job: pending, failed but due a retry (backing off
 * a minute per attempt), or processing but not updated for 15 minutes (the
 * worker heartbeats via `stage` changes, so silence means it died).
 * `SKIP LOCKED` lets several workers poll the same table without blocking each
 * other. Blobs no post references any more (deleted before transcoding) are
 * skipped.
 */
export async function claimJob(
  db: Kysely<Database>,
  maxAttempts: number,
): Promise<Job | undefined> {
  const query = sql<{ author_did: string; video_cid: string; attempts: number }>`
    update video_media
    set status = 'processing', stage = 'downloading',
        claimed_at = now(), attempts = attempts + 1, updated_at = now()
    where (author_did, video_cid) = (
      select m.author_did, m.video_cid from video_media m
      where (
          m.status = 'pending'
          or (m.status = 'failed' and m.attempts < ${maxAttempts}
              and m.updated_at < now() - m.attempts * interval '1 minute')
          or (m.status = 'processing' and m.attempts < ${maxAttempts}
              and m.updated_at < now() - ${STALE_CLAIM})
        )
        and exists (
          select 1 from video_post p
          where p.author_did = m.author_did and p.video_cid = m.video_cid
        )
      order by m.created_at
      limit 1
      for update skip locked
    )
    returning author_did, video_cid, attempts
  `
  const result = await purpose('Poll transcode queue', () => query.execute(db))

  const row = result.rows[0]
  return row && { authorDid: row.author_did, videoCid: row.video_cid, attempts: row.attempts }
}

/** Renditions of a blob no indexed post uses any more, to delete. */
export interface Removal {
  authorDid: string
  videoCid: string
}

/**
 * Claims the oldest blob queued for removal (status `removing`, set by the
 * AppView when its last post goes), unless another worker claimed it
 * recently. The row stays `removing` until {@link completeRemoval}.
 */
export async function claimRemoval(db: Kysely<Database>): Promise<Removal | undefined> {
  const query = sql<{ author_did: string; video_cid: string }>`
    update video_media
    set stage = 'removing', claimed_at = now(), updated_at = now()
    where (author_did, video_cid) = (
      select m.author_did, m.video_cid from video_media m
      where m.status = 'removing'
        and (m.claimed_at is null or m.claimed_at < now() - ${STALE_CLAIM})
      order by m.updated_at
      limit 1
      for update skip locked
    )
    returning author_did, video_cid
  `
  const result = await purpose('Poll removal queue', () => query.execute(db))
  const row = result.rows[0]
  return row && { authorDid: row.author_did, videoCid: row.video_cid }
}

/**
 * Forgets a blob whose renditions are gone. If a post started using the blob
 * again meanwhile, the AppView has set it back to `pending` and the row stays
 * to be transcoded afresh.
 */
export async function completeRemoval(db: Kysely<Database>, removal: Removal): Promise<void> {
  await purpose('Forget removed renditions', () =>
    db
      .deleteFrom('video_media')
      .where('author_did', '=', removal.authorDid)
      .where('video_cid', '=', removal.videoCid)
      .where('status', '=', 'removing')
      .execute(),
  )
}

/**
 * Records which pipeline step a claimed job is at, so operators can see where
 * each video is stuck. Only meaningful while the job is `processing`.
 */
export async function setStage(
  db: Kysely<Database>,
  job: Job,
  stage: VideoMediaStage,
): Promise<void> {
  await purpose('Record job stage', () =>
    db
      .updateTable('video_media')
      .set({ stage, updated_at: new Date() })
      .where('author_did', '=', job.authorDid)
      .where('video_cid', '=', job.videoCid)
      .execute(),
  )
}

export async function completeJob(
  db: Kysely<Database>,
  job: Job,
  media: { width: number; height: number; durationMs: number },
): Promise<void> {
  const query = db
    .updateTable('video_media')
    .set({
      status: 'ready',
      stage: 'done',
      width: media.width,
      height: media.height,
      duration_ms: media.durationMs,
      last_error: null,
      ready_at: new Date(),
      updated_at: new Date(),
    })
    .where('author_did', '=', job.authorDid)
    .where('video_cid', '=', job.videoCid)
  await purpose('Mark renditions ready', () => query.execute())
}

export async function failJob(db: Kysely<Database>, job: Job, error: string): Promise<void> {
  await purpose('Record transcode failure', () =>
    db
      .updateTable('video_media')
      .set({
        status: 'failed',
        stage: 'failed',
        last_error: error.slice(0, 2_000),
        updated_at: new Date(),
      })
      .where('author_did', '=', job.authorDid)
      .where('video_cid', '=', job.videoCid)
      .execute(),
  )
}

/** Job counts by status plus the oldest pending job's wait, for the status endpoint. */
export interface QueueStats {
  pending: number
  processing: number
  ready: number
  failed: number
  removing: number
  /** Seconds the oldest `pending` job has been waiting; 0 when none is. */
  oldestPendingSeconds: number
}

/**
 * Reads the queue depth straight from the table: every status is counted even
 * when it has no rows, and an empty queue reports zeros rather than an error.
 */
export async function queueStats(db: Kysely<Database>): Promise<QueueStats> {
  const rows = await purpose('Count transcode jobs by status', () =>
    db
      .selectFrom('video_media')
      .select(['status', db.fn.countAll<number>().as('count')])
      .groupBy('status')
      .execute(),
  )
  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    ready: 0,
    failed: 0,
    removing: 0,
    oldestPendingSeconds: 0,
  }
  for (const row of rows) stats[row.status] = Number(row.count)

  const oldest = await purpose('Oldest pending job wait', () =>
    sql<{ wait: number | null }>`
      select greatest(extract(epoch from now() - min(created_at)), 0)::integer as wait
      from video_media
      where status = 'pending'
    `.execute(db),
  )
  stats.oldestPendingSeconds = oldest.rows[0]?.wait ?? 0
  return stats
}
