import { MeshDataCommand } from './MeshDataCommand.js';

/**
 * One atomic, undoable mesh repair. execute() swaps in the repaired MeshData,
 * undo() restores the exact pre-repair MeshData — no partial weld/fill state
 * can remain, because the whole mesh is replaced as a single snapshot.
 * The repair report is kept for observability and survives serialization.
 */
export class RepairMeshCommand extends MeshDataCommand {
  static type = 'RepairMeshCommand';

  constructor(editor, object, beforeMeshData, afterMeshData, report = null) {
    super(editor, object, beforeMeshData, afterMeshData, 'Repair Mesh');
    this.report = report ? structuredClone(report) : null;
  }

  toJSON() {
    return { ...super.toJSON(), report: this.report };
  }

  static fromJSON(editor, json) {
    const command = super.fromJSON(editor, json);
    if (!command) return null;
    command.report = json.report ?? null;
    return command;
  }
}
