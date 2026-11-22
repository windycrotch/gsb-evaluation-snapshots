import { repairMeshData, analyzeMeshData } from '../geometry/ManifoldRepair.js';
import { RepairMeshCommand } from '../commands/RepairMeshCommand.js';

/**
 * Runs mesh repair as one observable, undoable operation per object.
 *
 * Atomicity: repairMeshData is pure — it never mutates the input mesh. The
 * repaired mesh is swapped in only via a single RepairMeshCommand, so a
 * failure leaves the object in its exact pre-repair state and an undo
 * restores it completely (no partial welds/fills, no dangling face ids).
 *
 * Re-entrancy: a repair requested while another repair on the same object is
 * still committing (e.g. triggered from a signal handler) is never interleaved
 * with the in-flight one. It is queued and runs strictly after, so the result
 * is equivalent to running the two repairs sequentially.
 */
export class RepairOps {
  constructor(editor) {
    this.editor = editor;
    this._inProgress = new Set(); // objectUuid currently committing a repair
    this._pending = new Map();    // objectUuid -> queued reentrant requests
  }

  static needsRepair(object) {
    const meshData = object?.userData?.meshData;
    if (!meshData) return false;
    return analyzeMeshData(meshData).needsRepair;
  }

  /**
   * Repair `object` now (or queue the request if one is mid-commit).
   * Returns { repaired, report?, analysis?, queued?, error? }.
   */
  repairObject(object, options = {}) {
    if (!object?.userData?.meshData) return { repaired: false, reason: 'no-mesh-data' };

    const key = object.uuid;

    if (this._inProgress.has(key)) {
      const queue = this._pending.get(key) ?? [];
      queue.push({ object, options });
      this._pending.set(key, queue);
      return { repaired: false, queued: true };
    }

    this._inProgress.add(key);
    try {
      let result = this._repairOnce(object, options);

      // Drain reentrant requests only after the current repair fully
      // committed — equivalent to sequential execution. Requests queued
      // while draining are drained in turn, so nothing is left pending.
      while (this._pending.get(key)?.length) {
        const queue = this._pending.get(key);
        this._pending.delete(key);
        for (const request of queue) {
          const r = this._repairOnce(request.object, request.options);
          if (r.repaired || !result.repaired) result = r;
        }
      }

      return result;
    } finally {
      this._inProgress.delete(key);
    }
  }

  _repairOnce(object, options) {
    const meshData = object.userData.meshData;
    const analysis = analyzeMeshData(meshData);

    if (!analysis.needsRepair && !options.force) {
      return { repaired: false, analysis };
    }

    let repaired;
    try {
      repaired = repairMeshData(meshData, options);
    } catch (err) {
      // Atomic failure: the object keeps its complete pre-repair state.
      console.warn(`Mesh repair failed for "${object.name || object.uuid}"; object left unchanged.`, err);
      return { repaired: false, error: String(err?.message ?? err), analysis };
    }

    const report = repaired.repairReport;
    const command = new RepairMeshCommand(this.editor, object, meshData, repaired, report);
    this.editor.execute(command);
    this.editor.signals.meshRepaired?.dispatch({ object, report });
    this.editor.signals.objectChanged?.dispatch(object);

    return { repaired: true, report, analysis };
  }
}
