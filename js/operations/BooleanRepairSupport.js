import { RepairMeshCommand } from '../commands/RepairMeshCommand.js';

// Shared plumbing for boolean ops (union / difference / intersect): collect repair
// descriptors from toManifold() results and fold their undoable commands into the
// composite boolean command.

export function collectRepairDescriptors(entries) {
  const repairs = [];
  for (const { object, entry } of entries) {
    if (!entry.repaired) continue;
    repairs.push({
      object,
      objectUuid: object.uuid,
      beforeMeshData: structuredClone(object.userData.meshData),
      afterMeshData: entry.repairedMeshData,
      report: entry.report,
    });
  }
  return repairs;
}

// Append repair commands, then the boolean + removal commands, to `multi`.
// Undo order therefore restores: removed operand → boolean result → repaired meshes →
// original raw meshes (with original face ids).
export function appendBooleanCommands({
  multi,
  editor,
  primary,
  booleanCommandCtor,
  resultMeshData,
  beforeMeshData,
  repairs,
  secondary,
  removeObjectCommandCtor,
}) {
  for (const repair of repairs) {
    multi.add(() => new RepairMeshCommand(
      editor,
      repair.object,
      repair.beforeMeshData,
      repair.afterMeshData,
      repair.report
    ));
  }

  // If the primary was repaired, the boolean command's before-state is the repaired mesh;
  // the RepairMeshCommand above is what restores the original raw mesh on full undo.
  const primaryRepair = repairs.find(r => r.objectUuid === primary.uuid);
  const booleanBefore = primaryRepair ? primaryRepair.afterMeshData : beforeMeshData;
  multi.add(() => new booleanCommandCtor(editor, primary, booleanBefore, resultMeshData));
  multi.add(() => new removeObjectCommandCtor(editor, secondary));
}
