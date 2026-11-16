// The model is a glTF 2.0 asset containing two indexed triangle meshes.
// Attribution and source links are included in the model and assets/ATTRIBUTION.md.
const meshUrl = new URL('../assets/leg.glb', import.meta.url);

async function readAsset() {
  const response = await fetch(meshUrl);
  if (!response.ok) throw new Error(`Cannot load leg model (${response.status})`);

  const buffer = await response.arrayBuffer();
  const header = new DataView(buffer);
  const jsonSize = header.getUint32(12, true);
  const binaryHeader = 20 + jsonSize;
  if (header.getUint32(0, true) !== 0x46546c67 ||
      header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== buffer.byteLength ||
      header.getUint32(16, true) !== 0x4e4f534a ||
      header.getUint32(binaryHeader + 4, true) !== 0x004e4942) {
    throw new Error('Invalid leg model');
  }

  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonSize)));
  return { buffer, document, binaryOffset: binaryHeader + 8 };
}

function toGeometry(THREE, mesh, asset) {
  const { buffer, document, binaryOffset } = asset;
  const { attributes, indices } = mesh.primitives[0];

  function readAccessor(index, itemSize, ArrayType) {
    const entry = document.accessors[index];
    const view = document.bufferViews[entry.bufferView];
    const offset = binaryOffset + (view.byteOffset ?? 0) + (entry.byteOffset ?? 0);
    return new ArrayType(buffer, offset, entry.count * itemSize);
  }

  const positions = readAccessor(attributes.POSITION, 3, Float32Array);
  const normals = readAccessor(attributes.NORMAL, 3, Float32Array);
  const uvData = attributes.TEXCOORD_0 === undefined
    ? new Float32Array(positions.length / 3 * 2).fill(-1)
    : readAccessor(attributes.TEXCOORD_0, 2, Float32Array).slice();

  // Convert texture coordinates back to the bottom-origin convention of the shader.
  if (attributes.TEXCOORD_0 !== undefined) {
    for (let i = 1; i < uvData.length; i += 2) uvData[i] = 1 - uvData[i];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvData, 2));
  geometry.setIndex(new THREE.BufferAttribute(readAccessor(indices, 1, Uint16Array), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function loadMesh(THREE) {
  const asset = await readAsset();
  const [stocking, skin] = asset.document.meshes;
  return {
    stocking: toGeometry(THREE, stocking, asset),
    skin: toGeometry(THREE, skin, asset),
  };
}
