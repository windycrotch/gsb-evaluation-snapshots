import { resolveTargets } from '../AgentUtils.js';
import { AXES_NOTE } from '../AgentAxes.js';

const NAME = 'mesh.repairReport';

// Read-only access to the manifold-repair fallback history of a mesh.
// Reports are stored:
//   - on the object's userData.lastRepairReport (latest repair applied to it),
//   - inside the undoable RepairMeshCommand in editor history (survives undo/redo and save).
export const meshRepairReportSpec = {
  description:
    AXES_NOTE +
    'Read-only report of the last automatic manifold repair applied to a mesh (the fallback that runs ' +
    'when a boolean rejects the raw mesh). Returns counts: weldedVerts, removedFaces, splitVerts, ' +
    'flippedFaces, filledHoles, skippedHoles; the exact repairFaceIds (new faces flagged isRepairFace, ' +
    'with ids that never collide with original face ids), originalFaceIds, and the warnings list ' +
    '(including holes skipped for exceeding the edge limit). Also scans the undo/redo history for ' +
    'RepairMeshCommands targeting the object. Returns null when no repair ever ran.',
  mutates: false,
  params: {
    target: { type: 'string', description: 'uuid or name of a mesh object.' },
  },

  run(params, editor) {
    const objects = resolveTargets(editor, params.target);
    if (objects.length !== 1) throw new Error(`${NAME}: target must resolve to exactly one object.`);
    const object = objects[0];
    const meshData = object.userData?.meshData;
    if (!meshData) {
      throw new Error(`${NAME}: "${object.name || object.uuid}" is not an editable mesh.`);
    }

    const latest = object.userData?.lastRepairReport ?? meshData?.repairReport ?? null;

    // Walk history so the report is queryable even after the object's userData was overwritten
    // by later edits, and include whether each entry is currently on the undo or redo stack.
    const history = [];
    const scan = (stack, state) => {
      for (const cmd of stack) {
        for (const entry of flattenRepairCommands(cmd)) {
          if (entry.command.objectUuid === object.uuid) {
            history.push({
              state,
              commandName: entry.command.name,
              report: entry.command.repairReport,
            });
          }
        }
      }
    };
    scan(editor.history.undos, 'undo');
    scan(editor.history.redos, 'redo');

    // Faces currently carrying the repair marker on the live mesh.
    const markedFaces = [];
    for (const face of meshData.faces.values()) {
      if (face.isRepairFace) markedFaces.push(face.id);
    }
    markedFaces.sort((a, b) => a - b);

    return {
      uuid: object.uuid,
      name: object.name || '(unnamed)',
      latestReport: latest,
      markedRepairFaceIds: markedFaces,
      history,
      repaired: !!(latest || history.length || markedFaces.length),
    };
  },
};

// SequentialMultiCommand nests the actual commands; flatten to RepairMeshCommand entries.
function flattenRepairCommands(cmd) {
  const out = [];
  if (!cmd) return out;
  if (cmd.constructor?.type === 'RepairMeshCommand') {
    out.push({ command: cmd });
  }
  if (Array.isArray(cmd.commands)) {
    for (const sub of cmd.commands) out.push(...flattenRepairCommands(sub));
  }
  return out;
}
