import { computeBoolean } from '../geometry/MeshDataManifold.js';
import { RemoveObjectCommand } from '../commands/RemoveObjectCommand.js';
import { UnionCommand } from '../commands/UnionCommand.js';
import { SequentialMultiCommand } from '../commands/SequentialMultiCommand.js';
import { SetSelectionCommand } from '../commands/SetSelectionCommand.js';

export class UnionOps {
  constructor(editor) {
    this.editor = editor;
  }

  /**
   * Union `secondary` into `primary`, replace primary's mesh with the result and remove
   * `secondary`, as one undoable step. Returns true on success, false if the inputs are invalid.
   * Throws if the boolean fails.
   */
  async union(primary, secondary) {
    const computed = await this.compute(primary, secondary);
    if (!computed) return false;

    this.commit(primary, secondary, computed);
    return true;
  }

  // Step 1 (async): compute the result without touching the scene. Null if the inputs are invalid.
  async compute(primary, secondary) {
    if (!UnionOps.canUnion(primary, secondary)) return null;

    // Clone before any await so the undo state is the mesh as it was when the user confirmed
    const beforeMeshData = structuredClone(primary.userData.meshData);
    const { meshData: resultMeshData, repairReports } = await UnionOps.computeUnion(primary, secondary);

    return { beforeMeshData, resultMeshData, repairReports };
  }

  // Step 2 (sync): apply a computed result as one undoable step.
  commit(primary, secondary, { beforeMeshData, resultMeshData }) {
    this.editor.execute(
      UnionOps.createCommand(this.editor, primary, secondary, beforeMeshData, resultMeshData)
    );
  }

  // Non-interactive helpers.

  static canUnion(primary, secondary) {
    return !!primary?.userData?.meshData
      && !!secondary?.userData?.meshData
      && primary !== secondary;
  }

  // Returns { meshData, repairReports } for primary ∪ secondary, keeping face ids traceable to the inputs.
  static async computeUnion(primary, secondary) {
    return computeBoolean(primary, secondary, 'add');
  }

  static createCommand(editor, primary, secondary, beforeMeshData, resultMeshData) {
    const prevSelection = [...editor.selection.selectedObjects];

    const multi = new SequentialMultiCommand(editor, 'Union Objects');
    multi.add(() => new SetSelectionCommand(editor, [primary], prevSelection));
    multi.add(() => new UnionCommand(editor, primary, beforeMeshData, resultMeshData));
    multi.add(() => new RemoveObjectCommand(editor, secondary));
    return multi;
  }
}