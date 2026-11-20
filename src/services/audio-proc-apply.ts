/**
 * Serialized apply+persist pipeline for audio processing writes (issue #527,
 * OL-25 follow-up). Shared by the controller WS `AUDIO_PROC_SET` handler and
 * the REST `PATCH .../audio/:elementId/processing` route so both paths obey
 * the same ordering and durability rules:
 *
 *   1. PER-PRODUCTION SERIALISATION — every write for a production runs after
 *      the previous one fully settled (Strom call + DB write). Two sets that
 *      interleave on the same channel — or a second set that arrives while the
 *      previous Strom call is still in flight — therefore reach Strom and the
 *      database in arrival order, and the LAST one wins. An older in-flight
 *      write can never land after a newer one and clobber it.
 *   2. STROM FIRST, PERSIST ON SUCCESS — a value is only written to the
 *      production doc after Strom confirmed it (or when there is nothing to
 *      apply live: production inactive, or a construction-time-only change
 *      such as `ch{N}_hpf_enabled`). A failed Strom write persists NOTHING, so
 *      the stored state — and therefore the connect/reactivation replay —
 *      always reflects values that actually took effect, never a value Strom
 *      refused or never saw.
 *   3. READ-MODIFY-WRITE PERSIST — the merge into `doc.audioProcessing` runs
 *      against a FRESHLY read doc inside the 409-retry loop, so two writes to
 *      different stages of the same channel (e.g. gain + hpf) can no longer
 *      lose one another the way a stale `mergeIntoStore(oldDoc)` + blind
 *      whole-field replace did.
 */

import { getDb } from '../db/index.js';
import type { ProductionDoc } from '../db/types.js';
import {
  type AudioProcStage,
  type StageParams,
  type AudioProcessingStore,
  mergeIntoStore,
  stageToStromProps,
} from '../lib/audio-processing.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

/** Cap on a single Strom block-properties write so a hung Strom cannot stall
 * the per-production chain (matches the REST route's previous 5 s timeout). */
const STROM_WRITE_TIMEOUT_MS = 5000;

/** Insert attempts before giving up on a CouchDB 409 (mirrors updateProductionDoc). */
const MAX_DB_WRITE_RETRIES = 3;

/** Where the write is headed: the running flow + mixer block, when active. */
export interface AudioProcApplyTarget {
  stromFlowId?: string;
  audioBlockId?: string;
}

export interface AudioProcApplyOutcome {
  /** True when live keys were written to Strom and Strom accepted them. */
  applied: boolean;
  /** The persisted store after this write (already on the production doc). */
  store: AudioProcessingStore;
}

// ---------------------------------------------------------------------------
// Per-production serialisation chain (same shape as the switcher chain in
// ws/controller.ts, issue #431)
// ---------------------------------------------------------------------------

const procChains = new Map<string, Promise<unknown>>();

function enqueue<T>(productionId: string, task: () => Promise<T>): Promise<T> {
  const prev = procChains.get(productionId) ?? Promise.resolve();
  const result = prev.then(() => task());
  const tail = result.catch(() => {});
  procChains.set(productionId, tail);
  void tail.then(() => {
    if (procChains.get(productionId) === tail) procChains.delete(productionId);
  });
  return result;
}

function isConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    (err as { statusCode?: number }).statusCode === 409
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Strom request timed out')), ms),
    ),
  ]);
}

/**
 * Merge `(elementId, stage, params)` into the production's persisted
 * `audioProcessing`, re-reading the doc on every attempt so a concurrent
 * write to another stage is never clobbered and a 409 simply retries against
 * the fresh `_rev`. Returns the store that was written.
 */
async function persistStage(
  productionId: string,
  elementId: string,
  stage: AudioProcStage,
  params: StageParams,
): Promise<AudioProcessingStore> {
  const db = getDb();
  for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
    try {
      const doc = (await db.get(productionId)) as ProductionDoc;
      const next = mergeIntoStore(doc.audioProcessing, elementId, stage, params);
      await db.insert({ ...doc, audioProcessing: next, updatedAt: new Date().toISOString() });
      return next;
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_DB_WRITE_RETRIES - 1) continue;
      throw err;
    }
  }
  // Unreachable (the loop either returns or throws), but keeps TS happy.
  throw new Error('Failed to persist audio processing');
}

/**
 * Apply one validated audio-processing change and persist it.
 *
 * Order inside the (serialized) task:
 *   1. If the production is active and the change carries LIVE Strom keys,
 *      PATCH the mixer block first. Any failure (rejected properties,
 *      transport, timeout) propagates and NOTHING is persisted.
 *   2. Persist the change on the production doc (read-modify-write).
 *
 * Construction-time-only changes (`ch{N}_hpf_enabled`) and writes while the
 * production is inactive skip step 1 — they take effect on the next
 * activation via the flow generator — and report `applied: false`.
 */
export async function applyAudioProcSet(
  productionId: string,
  elementId: string,
  stage: AudioProcStage,
  params: StageParams,
  target: AudioProcApplyTarget,
): Promise<AudioProcApplyOutcome> {
  return enqueue(productionId, async () => {
    const { live } = stageToStromProps(elementId, stage, params);
    let applied = false;
    if (target.stromFlowId && target.audioBlockId && Object.keys(live).length > 0) {
      const token = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token });
      await withTimeout(
        strom.flows.updateBlockProperties(target.stromFlowId, target.audioBlockId, { properties: live }),
        STROM_WRITE_TIMEOUT_MS,
      );
      applied = true;
    }
    const store = await persistStage(productionId, elementId, stage, params);
    return { applied, store };
  });
}
