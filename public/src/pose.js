const radians = Math.PI / 180;
const hip = [0, .90, .030];
const knee = [0, .49, .015];
const ankle = [.005, .075, .005];
const toe = [0, .022, .135];

const poses = {
  single: [{ x: 0 }, { x: .092, yaw: 6 }],
  together: [{ x: .089, yaw: 7, roll: -1.2 },
    { x: .089, yaw: 4, roll: -1, pitch: -1.5, knee: 3 }],
  step: [{ x: .084, z: .012, yaw: 15, roll: -4.2, pitch: -8, knee: 6 },
    { x: .092, z: -.012, yaw: 8, roll: -.5, pitch: 2.5 }],
  crossed: [{ x: .100, yaw: 12, roll: -16, pitch: -15, knee: 12 },
    { x: .100, yaw: 5, roll: -6, pitch: 3 }],
  tiptoe: [{ x: .090, yaw: 7, roll: -1, heel: 38 },
    { x: .090, yaw: 5, roll: -1, pitch: -2, knee: 5, heel: 33 }],
  point: [{ x: .087, yaw: 13, roll: -4, pitch: -17, ankle: 34, toe: -24 },
    { x: .092, yaw: 8 }],
  pigeon: [{ x: .094, yaw: -20, roll: 4.5, pitch: -9, knee: 15 },
    { x: .095, yaw: -17, roll: 4.2, pitch: -7.5, knee: 12 }],
};

function smoothstep(lower, upper, value) {
  const t = Math.max(0, Math.min(1, (value - lower) / (upper - lower)));
  return t * t * (3 - 2 * t);
}

function xRotation(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return (x, y, z) => [x, c * y - s * z, s * y + c * z];
}

function zRotation(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return (x, y, z) => [c * x - s * y, s * x + c * y, z];
}

function yRotation(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return (x, y, z) => [c * x + s * z, y, c * z - s * x];
}

function rotateAround(point, [x, y, z], rotation, weight = 1) {
  const [a, b, c] = rotation(point[0] - x, point[1] - y, point[2] - z);
  point[0] += (a + x - point[0]) * weight;
  point[1] += (b + y - point[1]) * weight;
  point[2] += (c + z - point[2]) * weight;
}

function makeTransform(config) {
  const pitch = xRotation((config.pitch ?? 0) * radians);
  const roll = zRotation((config.roll ?? 0) * radians);
  const yaw = yRotation((config.yaw ?? 0) * radians);
  const swing = (x, y, z) => yaw(...roll(...pitch(x, y, z)));
  const flexKnee = xRotation((config.knee ?? 0) * radians);
  const solePitch = Math.asin(Math.max(-1, Math.min(1, swing(...flexKnee(0, 0, 1))[1])));
  const soleRoll = Math.atan2(-swing(1, 0, 0)[1], swing(...flexKnee(0, 1, 0))[1]);
  const heel = config.heel ?? 0;
  const plantar = xRotation(solePitch + (heel + (config.ankle ?? 0)) * radians);
  const invert = zRotation(soleRoll);
  const flexAnkle = (x, y, z) => invert(...plantar(x, y, z));
  const flexToe = xRotation(((config.toe ?? 0) - heel) * radians);

  return (x, y, z) => {
    const point = [x, y, z];
    if (z > .12 && y < .07) {
      const heelWeight = smoothstep(.12, .155, z) * (1 - smoothstep(.05, .07, y));
      rotateAround(point, toe, flexToe, heelWeight);
    }
    if (y < .125) rotateAround(point, ankle, flexAnkle, 1 - smoothstep(.06, .125, y));
    if (y < .565) rotateAround(point, knee, flexKnee, 1 - smoothstep(.415, .565, y));
    rotateAround(point, hip, swing);
    return point;
  };
}

function soleHeight(vertices, transform) {
  let minimum = Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    if (vertices[i + 1] < .14) {
      const posedHeight = transform(vertices[i], vertices[i + 1], vertices[i + 2])[1];
      minimum = Math.min(minimum, posedHeight);
    }
  }
  return minimum;
}

const resolved = new WeakMap();
const applied = new WeakMap();

function resolvePose(restGeometry, name) {
  let cache = resolved.get(restGeometry);
  if (!cache) {
    cache = new Map();
    resolved.set(restGeometry, cache);
  }
  if (cache.has(name)) return cache.get(name);
  const vertices = restGeometry.attributes.position.array;
  const footLevel = restGeometry.boundingBox.min.y;
  const configs = poses[name];
  const second = makeTransform(configs[1]);
  let first = makeTransform(configs[0]);

  if (name === 'point') {
    const supportingHeight = soleHeight(vertices, second);
    let low = 0, high = 80;
    for (let i = 0; i < 16; i++) {
      const angle = (low + high) / 2;
      const option = makeTransform({ ...configs[0], knee: angle });
      if (soleHeight(vertices, option) > supportingHeight) low = angle;
      else high = angle;
    }
    first = makeTransform({ ...configs[0], knee: (low + high) / 2 });
  }

  const result = [first, second].map((transform, leg) => ({
    transform, x: configs[leg].x * (leg === 0 ? 1 : -1),
    y: footLevel - soleHeight(vertices, transform), z: configs[leg].z ?? 0,
    visible: name !== 'single' || leg === 0,
  }));
  cache.set(name, result);
  return result;
}

function cross([ax, ay, az], [bx, by, bz]) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function transformNormal(transform, point, [x, y, z], [nx, ny, nz]) {
  // The cofactor matrix derived from the deformation preserves seam normals.
  const delta = .0001;
  const jacobian = [
    transform(x + delta, y, z),
    transform(x, y + delta, z),
    transform(x, y, z + delta),
  ].map(q => q.map((value, index) => (value - point[index]) / delta));
  const [u, v, w] = jacobian;
  const a = cross(v, w), b = cross(w, u), c = cross(u, v);
  const result = a.map((value, index) => value * nx + b[index] * ny + c[index] * nz);
  const length = Math.hypot(...result) || 1;
  return result.map(value => value / length);
}

export function applyPose(geometry, restGeometry, poseName, legIndex) {
  const name = Object.hasOwn(poses, poseName) ? poseName : 'step';
  const pose = resolvePose(restGeometry, name)[legIndex];
  const { transform, x, y, z, visible } = pose;
  const placement = { x, y, z, visible };
  if (applied.get(geometry) === pose) return placement;

  const { position, normal } = geometry.attributes;
  const rest = restGeometry.attributes;
  if (!pose.vertices) {
    pose.vertices = new Float32Array(rest.position.array.length);
    pose.normals = new Float32Array(rest.normal.array.length);
    for (let i = 0; i < rest.position.count; i++) {
      const offset = 3 * i;
      const sourcePoint = rest.position.array.subarray(offset, offset + 3);
      const sourceNormal = rest.normal.array.subarray(offset, offset + 3);
      const point = transform(...sourcePoint);
      pose.vertices.set(point, offset);
      pose.normals.set(transformNormal(transform, point, sourcePoint, sourceNormal), offset);
    }
  }
  geometry.setAttribute('restPosition', rest.position);
  position.array.set(pose.vertices);
  normal.array.set(pose.normals);
  position.needsUpdate = true;
  normal.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  applied.set(geometry, pose);
  return placement;
}
