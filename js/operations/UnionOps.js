import { getManifoldWasm, toManifold, fromManifoldResult } from '../geometry/MeshDataManifold.js';
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
    const resultMeshData = await UnionOps.computeUnion(primary, secondary);

    return { beforeMeshData, resultMeshData };
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

  // Returns the MeshData for primary ∪ secondary, keeping face ids traceable to both inputs.
  static async computeUnion(primary, secondary) {
    await getManifoldWasm();

    // Secondary's id offset is derived from the ids actually used by primary
    // (including any repair faces added when primary had to be fixed).
    const a = await toManifold(primary, 0);
    const b = await toManifold(secondary, a.nextFaceId);

    let result = null;
    try {
      result = a.manifold.add(b.manifold);
      const status = result.status();
      if (status !== 'NoError') {
        throw new Error(`Boolean union failed (status: ${status})`);
      }
      return fromManifoldResult(result.getMesh(), a.faceIdMap, b.faceIdMap, primary);
    } finally {
      // Manifold objects live in WASM memory and aren't garbage collected.
      result?.delete?.();
      a.manifold.delete?.();
      b.manifold.delete?.();
    }
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