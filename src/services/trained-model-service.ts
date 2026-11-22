import { selectTrainedIndexEntry } from '../core/generator/trained-markov'
import {
  TrainedMarkovArtifactSchema,
  TrainedModelIndexSchema,
  type TrainedMarkovArtifact,
  type TrainedModelIndex,
  type TrainedRole
} from '../core/schemas/trained-markov.schema'

/**
 * On-demand loader for offline-trained Markov transition tables.
 *
 * Tables are shipped in the `markov-tables/` project directory and dynamically
 * imported on first use. Every load — index or artifact — is observable:
 * callers can distinguish a healthy trained model from a synthetic-scale
 * fallback via {@link getTrainedModelStatus} / {@link subscribeTrainedModelStatus}.
 *
 * Resilience rules:
 * - A failure is never cached. Only in-flight requests and successful results
 *   are remembered, so the next request retries the underlying import.
 * - Concurrent requests for the same role share one in-flight load and all
 *   observe the same outcome.
 * - Roles are isolated: a failed bass load never touches a cached melody or
 *   arp artifact. A failed index validation puts every role into fallback
 *   until a later index load succeeds.
 */

export type TableLoader = () => Promise<unknown>

const DEFAULT_LOADERS: Record<string, TableLoader> = {
  'index.json': () => import('@markov-tables/index.json'),
  'melodymate-markov-arp-default.json': () => import('@markov-tables/melodymate-markov-arp-default.json'),
  'melodymate-markov-bass-default.json': () => import('@markov-tables/melodymate-markov-bass-default.json'),
  'melodymate-markov-melody-default.json': () => import('@markov-tables/melodymate-markov-melody-default.json')
}

const TRAINED_ROLES: readonly TrainedRole[] = ['melody', 'bass', 'arp']

/** Why a trained model (or the index) could not be loaded. */
export type TrainedModelFailureReason =
  | 'index-missing'
  | 'index-invalid'
  | 'index-load-error'
  | 'model-missing'
  | 'model-invalid'
  | 'model-load-error'
  | 'model-mismatch'
  | 'no-entry'

export type TrainedModelLoadStatus = 'idle' | 'loading' | 'available' | 'fallback'
export type TrainedIndexLoadStatus = 'idle' | 'loading' | 'available' | 'fallback'

export interface TrainedModelStatus {
  status: TrainedModelLoadStatus
  /** Present (and validated) only while status is 'available'. */
  model: TrainedMarkovArtifact | null
  /** Failure classification while status is 'fallback'; null otherwise. */
  reason: TrainedModelFailureReason | null
  /** Human-readable explanation of the current status, suitable for UI display. */
  message: string
  /** Number of load attempts (including the one in flight); supports retry UX and tests. */
  attempts: number
}

export interface TrainedIndexStatus {
  status: TrainedIndexLoadStatus
  index: TrainedModelIndex | null
  reason: TrainedModelFailureReason | null
  message: string
  attempts: number
}

export const TRAINED_ROLE_LABELS: Record<TrainedRole, string> = {
  melody: 'Melody',
  bass: 'Bass',
  arp: 'Arpeggio'
}

function roleLabel(role: TrainedRole): string {
  return TRAINED_ROLE_LABELS[role]
}

let customLoaders: Record<string, TableLoader> | null = null

function getLoader(filename: string): TableLoader | undefined {
  if (customLoaders) {
    return customLoaders[filename]
  }
  return DEFAULT_LOADERS[filename]
}

function unwrapModule(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    return (mod as { default: unknown }).default
  }
  return mod
}

// --- Observable status state -------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function idleModelStatus(): TrainedModelStatus {
  return { status: 'idle', model: null, reason: null, message: '', attempts: 0 }
}

function idleIndexStatus(): TrainedIndexStatus {
  return { status: 'idle', index: null, reason: null, message: '', attempts: 0 }
}

let indexState: TrainedIndexStatus = idleIndexStatus()
const roleStates = new Map<TrainedRole, TrainedModelStatus>(TRAINED_ROLES.map((role) => [role, idleModelStatus()]))

function getRoleState(role: TrainedRole): TrainedModelStatus {
  let state = roleStates.get(role)
  if (!state) {
    state = idleModelStatus()
    roleStates.set(role, state)
  }
  return state
}

function setRoleState(role: TrainedRole, patch: Partial<TrainedModelStatus>): void {
  const current = getRoleState(role)
  roleStates.set(role, { ...current, ...patch })
  notifyListeners()
}

function markAllRolesFallback(reason: TrainedModelFailureReason, message: string): void {
  for (const role of TRAINED_ROLES) {
    // An already available model must stay untouched: its cached artifact was
    // produced by an earlier, valid index and remains usable for that role.
    if (getRoleState(role).status === 'available') continue
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason,
      message: messageForRole(role, reason, message)
    })
  }
}

function messageForRole(role: TrainedRole, reason: TrainedModelFailureReason, detail?: string): string {
  const label = roleLabel(role)
  switch (reason) {
    case 'index-missing':
    case 'index-invalid':
    case 'index-load-error':
      return `Trained model index unavailable; ${label.toLowerCase()} uses the built-in scale table`
    case 'no-entry':
      return `No trained ${label.toLowerCase()} model in index; using the built-in scale table`
    case 'model-missing':
      return `Trained ${label.toLowerCase()} model file is missing; using the built-in scale table`
    case 'model-invalid':
      return `Trained ${label.toLowerCase()} model failed validation; using the built-in scale table`
    case 'model-mismatch':
      return `Trained ${label.toLowerCase()} model does not match its index entry; using the built-in scale table`
    case 'model-load-error':
      return `Trained ${label.toLowerCase()} model could not be loaded; using the built-in scale table`
    default:
      return detail ?? `Trained ${label.toLowerCase()} model unavailable; using the built-in scale table`
  }
}

/**
 * Subscribes to trained-model status changes. The listener fires whenever the
 * index or any role status changes. Returns an unsubscribe function.
 */
export function subscribeTrainedModelStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTrainedIndexStatus(): TrainedIndexStatus {
  return indexState
}

export function getTrainedModelStatus(role: TrainedRole = 'melody'): TrainedModelStatus {
  return getRoleState(role)
}

// --- Load internals ----------------------------------------------------------

// Successful indexes are cached; in-flight requests are de-duplicated. A
// rejected/settled-to-fallback promise is removed so the next call retries.
let indexPromise: Promise<TrainedModelIndex | null> | null = null

// Per-role state. Each entry is either an in-flight request or a resolved
// successful artifact. Fallback results are deleted to keep failures retryable.
const roleLoads = new Map<TrainedRole, Promise<TrainedMarkovArtifact | null>>()

function classifyIndexError(error: unknown): TrainedModelFailureReason {
  return error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'SyntaxError'
    ? 'index-invalid'
    : 'index-load-error'
}

async function fetchIndex(): Promise<TrainedModelIndex | null> {
  indexState = {
    status: 'loading',
    index: null,
    reason: null,
    message: 'Loading trained model index',
    attempts: indexState.attempts + 1
  }
  notifyListeners()

  const loader = getLoader('index.json')
  if (!loader) {
    return finishIndexFailure('index-missing', 'Trained model index loader is unavailable')
  }

  let raw: unknown
  try {
    raw = await loader()
  } catch (error) {
    return finishIndexFailure(classifyIndexError(error), error instanceof Error ? error.message : String(error))
  }

  const parsed = TrainedModelIndexSchema.safeParse(unwrapModule(raw))
  if (!parsed.success) {
    return finishIndexFailure('index-invalid', 'Trained model index failed schema validation')
  }

  indexState = {
    status: 'available',
    index: parsed.data,
    reason: null,
    message: '',
    attempts: indexState.attempts
  }
  notifyListeners()
  return parsed.data
}

function finishIndexFailure(reason: TrainedModelFailureReason, detail: string): null {
  indexPromise = null
  indexState = {
    status: 'fallback',
    index: null,
    reason,
    message: messageForRole('melody', reason, detail),
    attempts: indexState.attempts
  }
  notifyListeners()
  // The index gates every role: without it, no role can reach a trained table.
  markAllRolesFallback(reason, detail)
  return null
}

export function loadTrainedModelIndex(): Promise<TrainedModelIndex | null> {
  // A successfully validated index stays cached for the session.
  if (indexState.status === 'available' && indexState.index) {
    return Promise.resolve(indexState.index)
  }
  if (!indexPromise) {
    indexPromise = fetchIndex().finally(() => {
      // Clear the in-flight slot once settled. On success fetchIndex already
      // recorded the index; on failure finishIndexFailure already nulled it.
      if (indexState.status !== 'available') {
        indexPromise = null
      }
    })
  }
  return indexPromise
}

export async function loadTrainedModel(role: TrainedRole = 'melody'): Promise<TrainedMarkovArtifact | null> {
  const inFlight = roleLoads.get(role)
  if (inFlight) return inFlight

  const task = doLoadTrainedModel(role)
  roleLoads.set(role, task)
  try {
    return await task
  } finally {
    // Only keep successful results cached. A fallback outcome removes the
    // entry entirely so the next request retries from scratch.
    if (getRoleState(role).status !== 'available') {
      roleLoads.delete(role)
    }
  }
}

async function doLoadTrainedModel(role: TrainedRole): Promise<TrainedMarkovArtifact | null> {
  setRoleState(role, {
    status: 'loading',
    model: null,
    reason: null,
    message: `Loading ${roleLabel(role).toLowerCase()} trained model`,
    attempts: getRoleState(role).attempts + 1
  })

  const index = await loadTrainedModelIndex()
  if (!index) {
    // The index failure path already recorded the role-level fallback reason.
    return null
  }

  const entry = selectTrainedIndexEntry(index.models, role)
  if (!entry) {
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason: 'no-entry',
      message: messageForRole(role, 'no-entry')
    })
    return null
  }

  const loader = getLoader(entry.file)
  if (!loader) {
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason: 'model-missing',
      message: messageForRole(role, 'model-missing')
    })
    return null
  }

  let raw: unknown
  try {
    raw = await loader()
  } catch (error) {
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason: 'model-load-error',
      message: messageForRole(role, 'model-load-error', error instanceof Error ? error.message : String(error))
    })
    return null
  }

  const parsed = TrainedMarkovArtifactSchema.safeParse(unwrapModule(raw))
  if (!parsed.success) {
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason: 'model-invalid',
      message: messageForRole(role, 'model-invalid')
    })
    return null
  }

  const artifact = parsed.data
  if (artifact.id !== entry.id || artifact.role !== entry.role || artifact.style !== entry.style) {
    setRoleState(role, {
      status: 'fallback',
      model: null,
      reason: 'model-mismatch',
      message: messageForRole(role, 'model-mismatch')
    })
    return null
  }

  setRoleState(role, {
    status: 'available',
    model: artifact,
    reason: null,
    message: '',
    attempts: getRoleState(role).attempts
  })
  return artifact
}

export function resetTrainedModelCache(): void {
  indexPromise = null
  roleLoads.clear()
  indexState = idleIndexStatus()
  for (const role of TRAINED_ROLES) {
    roleStates.set(role, idleModelStatus())
  }
  notifyListeners()
}

/** Testing helper to stub table loaders without network mocking. */
export function setTrainedModelLoadersForTesting(loaders: Record<string, TableLoader> | null): void {
  customLoaders = loaders
  resetTrainedModelCache()
}
