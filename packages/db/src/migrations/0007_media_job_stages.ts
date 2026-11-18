import { sql, type Kysely } from 'kysely'

/**
 * Observable job stages for the media queue.
 *
 * `video_media.status` says whether a row is claimable; the new `stage` column
 * says where in the pipeline the job actually is, so operations can see what a
 * video is stuck on without reading worker logs:
 *
 *   queued → downloading → transcoding → publishing → done
 *      └──────── any step may land in ────────┘ failed
 *   removing: the blob's renditions are being deleted (set with status).
 *
 * Existing rows are backfilled from their `status` (`processing` is reported
 * as `downloading`, the first step a worker runs after claiming), so a queue
 * migrated in place stays claimable exactly as before — `status` and its
 * check constraint are untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('video_media')
    .addColumn('stage', 'text', (col) =>
      col
        .notNull()
        .defaultTo('queued')
        .check(
          sql`stage in ('queued', 'downloading', 'transcoding', 'publishing', 'done', 'failed', 'removing')`,
        ),
    )
    .execute()

  await sql`
    update video_media set stage = case status
      when 'pending' then 'queued'
      when 'processing' then 'downloading'
      when 'ready' then 'done'
      when 'failed' then 'failed'
      when 'removing' then 'removing'
    end
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('video_media').dropColumn('stage').execute()
}
