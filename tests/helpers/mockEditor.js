import { MeshData } from '../../js/core/MeshData.js';
import { Signal } from '../../js/utils/Signals.js';

/**
 * Minimal editor stand-in with the surface RepairOps + RepairMeshCommand
 * (via MeshDataCommand/SeamSnapshot) actually touch: signals, object lookup,
 * edit selection, a vertex editor that swaps meshData, and a command history
 * with execute/undo.
 */
export class MockEditor {
  constructor() {
    this.signals = {
      meshRepaired: new Signal(),
      objectChanged: new Signal(),
      seamsChanged: new Signal(),
      editSelectionRefresh: new Signal(),
      historyChanged: new Signal(),
    };
    this.objects = new Map();
    this.undos = [];
    this.redos = [];
    this.editSelection = { clearSelection() {} };

    this.vertexEditor = {
      object: null,
      setObject(object) { this.object = object; },
      applyMeshData(meshData) {
        this.object.userData.meshData = meshData instanceof MeshData
          ? meshData
          : MeshData.getRehydratedMeshData(meshData);
      },
    };
  }

  addObject(object) {
    this.objects.set(object.uuid, object);
    return object;
  }

  objectByUuid(uuid) {
    return this.objects.get(uuid) ?? null;
  }

  execute(cmd) {
    cmd.execute();
    this.undos.push(cmd);
    this.redos.length = 0;
    this.signals.historyChanged.dispatch();
  }

  undo() {
    const cmd = this.undos.pop();
    if (!cmd) return;
    cmd.undo();
    this.redos.push(cmd);
    this.signals.historyChanged.dispatch();
  }

  redo() {
    const cmd = this.redos.pop();
    if (!cmd) return;
    cmd.execute();
    this.undos.push(cmd);
    this.signals.historyChanged.dispatch();
  }
}

let nextUuid = 1;

export function makeMeshObject(meshData, name = 'mesh') {
  return {
    uuid: `obj-${nextUuid++}`,
    name,
    userData: { meshData },
  };
}

// Deep structural snapshot of a MeshData for before/after comparison.
export function meshSnapshot(meshData) {
  return {
    vertices: [...meshData.vertices.entries()]
      .map(([id, v]) => [id, v.position.x, v.position.y, v.position.z])
      .sort((a, b) => a[0] - b[0]),
    faces: [...meshData.faces.entries()]
      .map(([id, f]) => [id, [...f.vertexIds]])
      .sort((a, b) => a[0] - b[0]),
    edges: [...meshData.edges.entries()]
      .map(([id, e]) => [id, e.v1Id, e.v2Id])
      .sort((a, b) => a[0] - b[0]),
  };
}
