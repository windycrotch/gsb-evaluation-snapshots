import * as THREE from 'three';
import { Signal } from '../../js/utils/Signals.js';
import { MeshData } from '../../js/core/MeshData.js';

// Minimal history with the same execute/undo/redo/toJSON surface as core/History, but without
// importing the full command registry (which drags in renderer/wasm-only modules).
class TestHistory {
  constructor(editor) {
    this.editor = editor;
    this.undos = [];
    this.redos = [];
  }
  execute(cmd) {
    cmd.execute();
    this.undos.push(cmd);
    this.redos.length = 0;
    this.editor.signals.historyChanged.dispatch();
  }
  undo() {
    const cmd = this.undos.pop();
    if (!cmd) return;
    cmd.undo();
    this.redos.push(cmd);
    this.editor.signals.historyChanged.dispatch();
  }
  redo() {
    const cmd = this.redos.pop();
    if (!cmd) return;
    cmd.execute();
    this.undos.push(cmd);
    this.editor.signals.historyChanged.dispatch();
  }
  toJSON() {
    return { undos: this.undos.map((c) => c.toJSON()), redos: this.redos.map((c) => c.toJSON()) };
  }
}

// Minimal headless stand-in for the real Editor + VertexEditor. It implements exactly the
// surface the undoable commands touch, so command/history behavior can be tested without a
// renderer, DOM or Three.js scene graph.
export function makeHeadlessEditor() {
  const signals = {
    historyChanged: new Signal(),
    repairApplied: new Signal(),
    seamsChanged: new Signal(),
    editSelectionCleared: new Signal(),
    objectChanged: new Signal(),
  };

  const editor = {
    signals,
    history: null,
    objects: new Map(),
    selection: { selectedObjects: [], clearSelection() { this.selectedObjects = []; } },
    editSelection: { clearSelection() {} },
  };

  // Applies a MeshData snapshot the same way VertexEditor.applyMeshData does for the data model.
  editor.vertexEditor = {
    setObject(object) { this.object = object; },
    object: null,
    applyMeshData(meshData) {
      if (!this.object) return;
      this.object.userData.meshData = meshData;
      MeshData.getRehydratedMeshData(this.object.userData.meshData);
      // Rehydrate in place: ensure it is a MeshData instance with live Maps.
      if (!(this.object.userData.meshData instanceof MeshData)) {
        this.object.userData.meshData = MeshData.getRehydratedMeshData(this.object.userData.meshData);
      }
    },
  };

  editor.objectByUuid = (uuid) => editor.objects.get(uuid) ?? null;
  editor.execute = (cmd) => editor.history.execute(cmd);
  editor.undo = () => editor.history.undo();
  editor.redo = () => editor.history.redo();
  editor.add = (cmd) => editor.history.add(cmd);

  editor.history = new TestHistory(editor);

  // Detach/remove + add used by RemoveObjectCommand (no real scene graph in headless mode).
  const mainScene = new THREE.Object3D();
  editor.sceneManager = {
    mainScene,
    detachObject() {},
    removeObject(object) {
      editor.objects.delete(object.uuid);
      object.removeFromParent();
    },
    addObject(object, parent = mainScene) {
      editor.objects.set(object.uuid, object);
      parent.add(object);
    },
    attachObject() {},
  };
  // Commands call editor.toolbar.updateTools() after selection changes.
  editor.toolbar = { updateTools() {} };
  editor.selection.setSelection = (objs) => { editor.selection.selectedObjects = objs; };

  // mesh.inspect validates targets through modeManager.
  editor.modeManager = {
    currentMode: 'object',
    isValidMesh: (object) => !!object?.isMesh && !!object.userData?.meshData,
  };

  return editor;
}

// A headless mesh object carrying meshData, mirroring the real object shape enough for commands.
export function makeHeadlessObject(meshData, name = 'obj') {
  const object = new THREE.Object3D();
  object.name = name;
  object.isMesh = true;
  object.userData = { meshData };
  object.matrixWorld = new THREE.Matrix4().identity();
  return object;
}

// Register an object so objectByUuid and scene traversal can resolve it during undo/redo.
export function register(editor, object) {
  editor.objects.set(object.uuid, object);
  editor.sceneManager.mainScene.add(object);
  return object;
}
