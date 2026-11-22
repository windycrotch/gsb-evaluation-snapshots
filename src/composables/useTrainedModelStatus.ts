import { computed, readonly, ref, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import type { TrainedRole } from '../core/schemas/trained-markov.schema'
import {
  getTrainedIndexStatus,
  getTrainedModelStatus,
  loadTrainedModel,
  subscribeTrainedModelStatus,
  type TrainedModelStatus
} from '../services/trained-model-service'

/**
 * Reactive view over the trained-model service's observable status.
 *
 * The service itself stays Vue-free (and unit-testable in plain node); this
 * composable mirrors its per-role state into readonly refs. State is a
 * module-level singleton, so every component observes the same status and a
 * single load attempt is shared across the whole app.
 */
const indexStatus = ref(getTrainedIndexStatus())
const roleStatus = ref<Record<TrainedRole, TrainedModelStatus>>({
  melody: getTrainedModelStatus('melody'),
  bass: getTrainedModelStatus('bass'),
  arp: getTrainedModelStatus('arp')
})
const modelArtifacts: Record<TrainedRole, ShallowRef<TrainedModelStatus['model']>> = {
  melody: shallowRef(getTrainedModelStatus('melody').model),
  bass: shallowRef(getTrainedModelStatus('bass').model),
  arp: shallowRef(getTrainedModelStatus('arp').model)
}

let subscribed = false

function syncFromService(): void {
  indexStatus.value = getTrainedIndexStatus()
  for (const role of ['melody', 'bass', 'arp'] as const) {
    const snapshot = getTrainedModelStatus(role)
    roleStatus.value = { ...roleStatus.value, [role]: snapshot }
    modelArtifacts[role].value = snapshot.model
  }
}

function ensureSubscription(): void {
  if (subscribed) return
  subscribed = true
  subscribeTrainedModelStatus(syncFromService)
  syncFromService()
}

/** Test-only hook: re-pull state after a manual service cache reset. */
export function refreshTrainedModelStatusForTesting(): void {
  syncFromService()
}

/** Readonly reactive view of the index load state. */
export type TrainedIndexStatusRef = ReturnType<typeof readonly<typeof indexStatus>>

export interface TrainedModelStatusApi {
  /** Readonly reactive snapshot of the requested role's current load status. */
  status: ComputedRef<TrainedModelStatus>
  /** Validated artifact while available, otherwise null. */
  model: ShallowRef<TrainedModelStatus['model']>
  indexStatus: TrainedIndexStatusRef
  /** Retries the load; when healthy this resolves immediately from the service cache. */
  retry: () => Promise<TrainedModelStatus['model']>
}

export function useTrainedModelStatus(role: TrainedRole): TrainedModelStatusApi {
  ensureSubscription()

  const status = computed(() => roleStatus.value[role])

  return {
    status,
    model: modelArtifacts[role],
    indexStatus: readonly(indexStatus),
    retry: () => loadTrainedModel(role)
  }
}
