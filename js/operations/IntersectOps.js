import { getManifoldWasm, toManifold, fromManifoldResult } from '../geometry/MeshDataManifold.js';
import { RemoveObjectCommand } from '../commands/RemoveObjectCommand.js';
import { IntersectCommand } from '../commands/IntersectCommand.js';
import { SequentialMultiCommand } from '../commands/SequentialMultiCommand.js';
import { SetSelectionCommand } from '../commands/SetSelectionCommand.js';
import { collectRepairDescriptors, appendBooleanCommands } from './BooleanRepairSupport.js';

export class IntersectOps {
  constructor(editor) {
    this.editor = editor;
  }

  /**
   * Intersect `primary` with `secondary`, replace primary's mesh with the result and remove
   * `secondary`, as one undoable step. Returns true on success, false if the inputs are invalid.
   * Throws if the boolean fails (including failed repair).
   */
  async intersect(primary, secondary) {
    const computed = await this.compute(primary, secondary);
    if (!computed) return false;

    this.commit(primary, secondary, computed);
    return true;
  }

  // Step 1 (async): compute the result without touching the scene. Null if the inputs are invalid.
  async compute(primary, secondary) {
    if (!IntersectOps.canIntersect(primary, secondary)) return null;

    // Clone before any await so the undo state is the mesh as it was when the user confirmed
    const beforeMeshData = structuredClone(primary.userData.meshData);
    const { resultMeshData, repairs } = await IntersectOps.computeIntersection(primary, secondary);

    return { beforeMeshData, resultMeshData, repairs };
  }

  // Step 2 (sync): apply a computed result as one undoable step.
  commit(primary, secondary, { beforeMeshData, resultMeshData, repairs = [] }) {
    this.editor.execute(
      IntersectOps.createCommand(this.editor, primary, secondary, beforeMeshData, resultMeshData, repairs)
    );
  }

  // Non-interactive helpers.

  static canIntersect(primary, secondary) {
    return !!primary?.userData?.meshData
      && !!secondary?.userData?.meshData
      && primary !== secondary;
  }

  // Returns the MeshData for primary ∩ secondary, keeping face ids traceable to both inputs,
  // plus a `repairs` list for any operand that had to be auto-repaired.
  static async computeIntersection(primary, secondary) {
    const meshData = primary.userData.meshData;
    const idOffsetB = meshData.nextFaceId + meshData.vertices.size;

    await getManifoldWasm();

    const [a, b] = await Promise.all([
      toManifold(primary, 0),
      toManifold(secondary, idOffsetB),
    ]);

    let result = null;
    try {
      result = a.manifold.intersect(b.manifold);
      return {
        resultMeshData: fromManifoldResult(result.getMesh(), a.faceIdMap, b.faceIdMap, primary),
        repairs: collectRepairDescriptors([
          { object: primary, entry: a },
          { object: secondary, entry: b },
        ]),
      };
    } finally {
      // Manifold objects live in WASM memory and aren't garbage collected.
      result?.delete?.();
      a.manifold.delete?.();
      b.manifold.delete?.();
    }
  }

  static createCommand(editor, primary, secondary, beforeMeshData, resultMeshData, repairs = []) {
    const prevSelection = [...editor.selection.selectedObjects];

    const multi = new SequentialMultiCommand(editor, 'Intersect Objects');
    multi.add(() => new SetSelectionCommand(editor, [primary], prevSelection));

    appendBooleanCommands({
      multi,
      editor,
      primary,
      booleanCommandCtor: IntersectCommand,
      resultMeshData,
      beforeMeshData,
      repairs,
      secondary,
      removeObjectCommandCtor: RemoveObjectCommand,
    });
    return multi;
  }
}
