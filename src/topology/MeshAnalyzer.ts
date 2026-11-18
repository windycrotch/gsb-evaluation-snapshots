import * as THREE from 'three';
import { SkeletonRig, JointType, Joint } from '../types';

export class MeshAnalyzer {
  public bindSkeletonWithWeights(mesh: THREE.Mesh, rig: SkeletonRig, skinIndicesArr: Uint16Array, skinWeightsArr: Float32Array): THREE.SkinnedMesh {
    const geometry = mesh.geometry.clone();
    const { bones, root } = this.createBones(rig);

    const skeleton = new THREE.Skeleton(bones);

    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const vertexCount = positionAttr ? positionAttr.count : 0;
    const maxInfluences = 4;
    const boneCount = bones.length;

    // Defensive copy + sanitization: guarantee in-bounds indices and
    // normalized weights regardless of upstream solver quirks. A zero-vertex
    // mesh simply yields valid (zero-length) skin attributes.
    const safeIndices = new Uint16Array(Math.max(vertexCount, 0) * maxInfluences);
    const safeWeights = new Float32Array(Math.max(vertexCount, 0) * maxInfluences);

    for (let v = 0; v < vertexCount; v++) {
      const picked = new Array<number>(maxInfluences).fill(0);
      const raw = new Array<number>(maxInfluences).fill(0);

      for (let k = 0; k < maxInfluences; k++) {
        const srcIdx = v * maxInfluences + k;
        const index = skinIndicesArr[srcIdx];
        // Clamp to the valid skeleton range; anything malformed pins to bone 0.
        picked[k] = Number.isInteger(index) && index >= 0 && index < boneCount ? index : 0;
        const w = skinWeightsArr[srcIdx];
        raw[k] = Number.isFinite(w) && w > 0 ? w : 0;
      }

      const sum = raw.reduce((acc, w) => acc + w, 0);
      const out = new Array<number>(maxInfluences).fill(0);
      if (sum > 0) {
        for (let k = 0; k < maxInfluences; k++) out[k] = raw[k] / sum;
      } else {
        // Zero denominator (vertex unreachable by every bone): full weight
        // on the first valid influence so weights still sum to exactly 1.
        out[0] = 1;
      }

      for (let k = 0; k < maxInfluences; k++) {
        safeIndices[v * maxInfluences + k] = picked[k];
        safeWeights[v * maxInfluences + k] = out[k];
      }
    }

    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(safeIndices, maxInfluences));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(safeWeights, maxInfluences));

    const skinnedMesh = new THREE.SkinnedMesh(geometry, mesh.material);
    // Attach the actual hierarchy root (Hips), never bones[0] by assumption.
    skinnedMesh.add(root);
    skinnedMesh.bind(skeleton);

    return skinnedMesh;
  }

  /**
   * Builds THREE.Bone instances from a SkeletonRig.
   *
   * Position convention:
   *  - the root joint (Hips) uses its own world position;
   *  - every other joint's local position equals
   *    childJoint.world - parentJoint.world.
   *
   * Throws diagnostic errors (instead of producing silently mispositioned
   * bones) when the rig is empty, lacks Hips, references unknown joints in
   * the hierarchy, or leaves joints unreachable from the hierarchy.
   */
  private createBones(rig: SkeletonRig): { bones: THREE.Bone[]; root: THREE.Bone } {
    if (!rig || !rig.joints || !rig.hierarchy) {
      throw new Error('[MeshAnalyzer] Invalid SkeletonRig: rig, rig.joints and rig.hierarchy are required');
    }

    const boneMap = new Map<JointType, THREE.Bone>();
    const jointMap = new Map<JointType, Joint>();

    for (const [type, joint] of Object.entries(rig.joints) as [JointType, Joint][]) {
      if (
        !joint ||
        !joint.position ||
        ![joint.position.x, joint.position.y, joint.position.z].every(Number.isFinite)
      ) {
        throw new Error(`[MeshAnalyzer] Joint "${type}" is missing or has a non-finite position`);
      }
      const bone = new THREE.Bone();
      bone.name = type;
      boneMap.set(type, bone);
      jointMap.set(type, joint);
    }

    if (boneMap.size === 0) {
      throw new Error('[MeshAnalyzer] Cannot build a skeleton from a rig with no joints');
    }

    const hips = boneMap.get(JointType.Hips);
    if (!hips) {
      throw new Error('[MeshAnalyzer] Rig is missing the required root joint "Hips"');
    }
    if (!rig.hierarchy[JointType.Hips]) {
      throw new Error('[MeshAnalyzer] Hierarchy is missing an entry for root joint "Hips"');
    }

    // Root joint: local position is its own world position.
    const hipsJoint = jointMap.get(JointType.Hips)!;
    hips.position.set(hipsJoint.position.x, hipsJoint.position.y, hipsJoint.position.z);

    const connected = new Set<JointType>([JointType.Hips]);

    for (const [parentType, children] of Object.entries(rig.hierarchy) as [JointType, JointType[]][]) {
      const parentBone = boneMap.get(parentType);
      const parentJoint = jointMap.get(parentType);
      if (!parentBone || !parentJoint) {
        throw new Error(
          `[MeshAnalyzer] Hierarchy entry references joint "${parentType}", which is missing from rig.joints`
        );
      }

      const seenChildren = new Set<JointType>();
      for (const childType of children) {
        if (seenChildren.has(childType)) {
          throw new Error(`[MeshAnalyzer] Joint "${childType}" is listed more than once under parent "${parentType}"`);
        }
        seenChildren.add(childType);

        const childBone = boneMap.get(childType);
        const childJoint = jointMap.get(childType);
        if (!childBone || !childJoint) {
          throw new Error(
            `[MeshAnalyzer] Hierarchy of joint "${parentType}" references joint "${childType}", which is missing from rig.joints`
          );
        }
        if (connected.has(childType)) {
          throw new Error(
            `[MeshAnalyzer] Joint "${childType}" has multiple parents in the hierarchy (already reached before "${parentType}")`
          );
        }

        // Non-root joint: local position = child world position - parent world position.
        childBone.position.set(
          childJoint.position.x - parentJoint.position.x,
          childJoint.position.y - parentJoint.position.y,
          childJoint.position.z - parentJoint.position.z
        );

        parentBone.add(childBone);
        connected.add(childType);
      }
    }

    const orphaned = [...jointMap.keys()].filter(type => !connected.has(type));
    if (orphaned.length > 0) {
      throw new Error(
        `[MeshAnalyzer] Joints present in rig.joints but missing from the hierarchy: ${orphaned.join(', ')}`
      );
    }

    // Preserve rig.joints ordering: skeleton bone indices must match the
    // indices produced by the weight solver.
    const bones = [...jointMap.keys()].map(type => boneMap.get(type)!);
    return { bones, root: hips };
  }
}
