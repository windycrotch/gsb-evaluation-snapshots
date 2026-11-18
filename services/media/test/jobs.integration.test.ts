import { closeDb, createDb, migrateToLatest, type Database } from '@openreel/db'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { claimJob, queueStats } from '../src/jobs.ts'
import type { MediaStore } from '../src/store.ts'
import { Worker } from '../src/worker.ts'

/**
 * The media queue's claiming, retry, and stats behavior against a real
 * Postgres. Runs when TEST_DATABASE_URL is set (see
 * packages/db/test/integration.test.ts), in its own database beside that one
 * so suites do not race.
 */
const url = process.env['TEST_DATABASE_URL'] ?? ''
const NAME = 'openreel_media_jobs_test'

const DID = 'did:plc:author0000000000000000000'
const MAX_ATTEMPTS = 3

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

describe.skipIf(url === '')('media job queue against Postgres', () => {
  let admin: Kysely<Database>
  let db: Kysely<Database>

  beforeAll(async () => {
    admin = createDb(url)
    await sql`drop database if exists ${sql.id(NAME)}`.execute(admin)
    await sql`create database ${sql.id(NAME)}`.execute(admin)
    const own = new URL(url)
    own.pathname = `/${NAME}`
    db = createDb(own.toString())
    await migrateToLatest(db)
  })

  afterAll(async () => {
    await closeDb(db)
    await sql`drop database if exists ${sql.id(NAME)}`.execute(admin)
    await closeDb(admin)
  })

  beforeEach(async () => {
    await sql`truncate video_media, video_post, actor cascade`.execute(db)
    await db.insertInto('actor').values({ did: DID }).execute()
  })

  /** A post using the blob, so the queue row is claimable. */
  async function addPost(videoCid: string): Promise<void> {
    await db
      .insertInto('video_post')
      .values({
        uri: `at://${DID}/social.openreel.video.post/${videoCid}`,
        cid: `record-${videoCid}`,
        author_did: DID,
        video_cid: videoCid,
        created_at: new Date(),
      })
      .execute()
  }

  async function mediaRow(videoCid: string) {
    return db
      .selectFrom('video_media')
      .selectAll()
      .where('video_cid', '=', videoCid)
      .executeTakeFirstOrThrow()
  }

  it('claims the oldest pending job as processing, at the downloading stage', async () => {
    await addPost('bafkreiolder')
    await addPost('bafkreinewer')
    await db
      .insertInto('video_media')
      .values([
        { author_did: DID, video_cid: 'bafkreinewer', created_at: minutesAgo(1) },
        { author_did: DID, video_cid: 'bafkreiolder', created_at: minutesAgo(5) },
      ])
      .execute()

    const job = await claimJob(db, MAX_ATTEMPTS)
    expect(job).toMatchObject({ authorDid: DID, videoCid: 'bafkreiolder', attempts: 1 })

    const row = await mediaRow('bafkreiolder')
    expect(row.status).toBe('processing')
    expect(row.stage).toBe('downloading')
    expect(row.claimed_at).not.toBeNull()
    // The newer job is still queued.
    expect((await mediaRow('bafkreinewer')).status).toBe('pending')
  })

  it('migrates existing rows to a stage and keeps them claimable', async () => {
    // What a pre-migration row looks like after 0007's backfill.
    await addPost('bafkreilegacy')
    await db
      .insertInto('video_media')
      .values({ author_did: DID, video_cid: 'bafkreilegacy' })
      .execute()

    const job = await claimJob(db, MAX_ATTEMPTS)
    expect(job?.videoCid).toBe('bafkreilegacy')
  })

  it('backs a failed job off a minute per attempt, then stops at the cap', async () => {
    await addPost('bafkreifresh')
    await addPost('bafkreidue')
    await addPost('bafkreicapped')
    await db
      .insertInto('video_media')
      .values([
        // Failed 30s ago after one attempt: its one-minute backoff is not up.
        {
          author_did: DID,
          video_cid: 'bafkreifresh',
          status: 'failed',
          stage: 'failed',
          attempts: 1,
          updated_at: new Date(Date.now() - 30_000),
        },
        // Failed long enough ago for its two-attempt backoff: claimable.
        {
          author_did: DID,
          video_cid: 'bafkreidue',
          status: 'failed',
          stage: 'failed',
          attempts: 2,
          updated_at: minutesAgo(3),
        },
        // At the attempt cap: never claimed again, however old.
        {
          author_did: DID,
          video_cid: 'bafkreicapped',
          status: 'failed',
          stage: 'failed',
          attempts: MAX_ATTEMPTS,
          updated_at: minutesAgo(60),
        },
      ])
      .execute()

    const job = await claimJob(db, MAX_ATTEMPTS)
    expect(job?.videoCid).toBe('bafkreidue')
    // Nothing else is runnable: the fresh failure is backing off, the capped one is done.
    expect(await claimJob(db, MAX_ATTEMPTS)).toBeUndefined()
  })

  it('reclaims a processing job only after 15 minutes without an update', async () => {
    await addPost('bafkreistale')
    await addPost('bafkreiactive')
    await db
      .insertInto('video_media')
      .values([
        {
          author_did: DID,
          video_cid: 'bafkreistale',
          status: 'processing',
          stage: 'transcoding',
          attempts: 1,
          claimed_at: minutesAgo(20),
          updated_at: minutesAgo(16),
        },
        {
          author_did: DID,
          video_cid: 'bafkreiactive',
          status: 'processing',
          stage: 'transcoding',
          attempts: 1,
          claimed_at: minutesAgo(20),
          updated_at: minutesAgo(2),
        },
      ])
      .execute()

    const job = await claimJob(db, MAX_ATTEMPTS)
    expect(job?.videoCid).toBe('bafkreistale')
    // The actively updated one is left to its worker.
    expect(await claimJob(db, MAX_ATTEMPTS)).toBeUndefined()
  })

  it('claims a removal before a queued transcode', async () => {
    await addPost('bafkreiqueued')
    await db
      .insertInto('video_media')
      .values([
        { author_did: DID, video_cid: 'bafkreiqueued', created_at: minutesAgo(10) },
        {
          author_did: DID,
          video_cid: 'bafkreigone',
          status: 'removing',
          stage: 'removing',
          created_at: minutesAgo(20),
        },
      ])
      .execute()

    const removed: string[] = []
    const transcoded: string[] = []
    const store: MediaStore = {
      name: 'disk',
      workDir: () => Promise.resolve('/tmp/work'),
      publish: () => Promise.resolve(),
      discard: () => Promise.resolve(),
      remove: (did, cid) => (removed.push(`${did}/${cid}`), Promise.resolve()),
    }
    const worker = new Worker({
      db,
      identity: { resolve: (did) => Promise.resolve({ did }) },
      blobs: { download: () => Promise.reject(new Error('no downloads here')) },
      store,
      transcode: (input) => (transcoded.push(input), Promise.reject(new Error('stop'))),
      maxAttempts: MAX_ATTEMPTS,
      pollIntervalMs: 1000,
    })

    expect(await worker.runOnce()).toBe(true)
    expect(removed).toEqual([`${DID}/bafkreigone`])
    expect(transcoded).toEqual([])
    // The removal row is gone; the transcode job waited and is still queued.
    expect((await mediaRow('bafkreiqueued')).status).toBe('pending')
  })

  it('reports zeros for an empty queue', async () => {
    expect(await claimJob(db, MAX_ATTEMPTS)).toBeUndefined()
    expect(await queueStats(db)).toEqual({
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      removing: 0,
      oldestPendingSeconds: 0,
    })
  })

  it('counts every status and the oldest pending wait', async () => {
    await db
      .insertInto('video_media')
      .values([
        { author_did: DID, video_cid: 'bafkreione', created_at: minutesAgo(5) },
        { author_did: DID, video_cid: 'bafkreitwo', created_at: minutesAgo(1) },
        { author_did: DID, video_cid: 'bafkreithree', status: 'processing', stage: 'downloading' },
        { author_did: DID, video_cid: 'bafkreifour', status: 'ready', stage: 'done' },
        { author_did: DID, video_cid: 'bafkreifive', status: 'failed', stage: 'failed' },
        { author_did: DID, video_cid: 'bafkreisix', status: 'removing', stage: 'removing' },
      ])
      .execute()

    const stats = await queueStats(db)
    expect(stats).toMatchObject({
      pending: 2,
      processing: 1,
      ready: 1,
      failed: 1,
      removing: 1,
    })
    // The oldest pending row was queued five minutes ago.
    expect(stats.oldestPendingSeconds).toBeGreaterThanOrEqual(299)
    expect(stats.oldestPendingSeconds).toBeLessThan(330)
  })
})
