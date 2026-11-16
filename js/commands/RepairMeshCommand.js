import { MeshDataCommand } from './MeshDataCommand.js';
import { SeamSnapshot } from '../uv/SeamSnapshot.js';

/**
 * Records one manifold-repair fallback as an undoable history step.
 *
 * beforeMeshData = the original (broken) mesh with its original face ids;
 * afterMeshData  = the repaired mesh (repair faces carry isRepairFace + non-colliding ids).
 *
 * Undo restores the original mesh and face ids; redo returns to the repaired mesh.
 * The repair report is embedded in the command so it survives history serialization
 * and can be queried via the editor / agent even after undo/redo.
 */
export class RepairMeshCommand extends MeshDataCommand {
  static type = 'RepairMeshCommand';

  constructor(editor, object, beforeMeshData, afterMeshData, report = null) {
    super(editor, object, beforeMeshData, afterMeshData, 'Repair Mesh');
    this.repairReport = report
      ? structuredClone(report)
      : afterMeshData?.repairReport
        ? structuredClone(afterMeshData.repairReport)
        : null;
  }

  execute() {
    super.execute();
    this._storeReportOnObject();
    this.signals.repairApplied?.dispatch?.(this._payload());
  }

  undo() {
    super.undo();
    // The report stays queryable on the command itself; the object reverts to its raw state.
    this.signals.repairApplied?.dispatch?.(this._payload(true));
  }

  _storeReportOnObject() {
    const object = this.editor.objectByUuid(this.objectUuid);
    if (object && this.repairReport) {
      object.userData.lastRepairReport = structuredClone(this.repairReport);
    }
  }

  _payload(undone = false) {
    return {
      objectUuid: this.objectUuid,
      undone,
      report: this.repairReport,
    };
  }

  toJSON() {
    return {
      ...super.toJSON(),
      repairReport: this.repairReport,
    };
  }

  static fromJSON(editor, json) {
    if (!json || json.type !== this.type) return null;

    // Construct with null snapshots; the serialized snapshots are restored below.
    const command = new this(editor, null, null, null, json.repairReport ?? null);
    command.objectUuid = json.objectUuid;
    command.beforeMeshData = json.beforeMeshData;
    command.afterMeshData = json.afterMeshData;
    command.seam = SeamSnapshot.fromJSON(editor, json);
    command.seam.objectUuid = json.objectUuid;
    return command;
  }
}
