import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Both mascots are modelled as collectible vinyl figures: simple primitive builds with physically
// based materials so they pick up the arena's warm/cool rims and reflect in the wet floor.
// Rigs face +Z, origin at the feet.

function shadowed(root) {
  root.traverse((o) => {
    if (o.isMesh && !o.userData.noShadow) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return root;
}

function pixelBump() {
  // One "pixel" cell with a soft groove on its border; tiled across Clawd's faces so the sprite's
  // pixel grid survives as a subtle panel-line pattern.
  const N = 64;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, N, N);
  const grd = (x0, y0, x1, y1) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, 'rgba(0,0,0,0.85)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    return gr;
  };
  const w = 5;
  g.fillStyle = grd(0, 0, w, 0); g.fillRect(0, 0, w, N);
  g.fillStyle = grd(N, 0, N - w, 0); g.fillRect(N - w, 0, w, N);
  g.fillStyle = grd(0, 0, 0, w); g.fillRect(0, 0, N, w);
  g.fillStyle = grd(0, N, 0, N - w); g.fillRect(0, N - w, N, w);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// ----------------------------------------------------------------------------------------------
// CLAWD — Claude Code's pixel crab: a wide coral block, two tall eye slits, arm nubs, four legs.
// ----------------------------------------------------------------------------------------------
export const CLAWD_COLOR = new THREE.Color(0xb5533a);

export function buildClawd() {
  const root = new THREE.Group();
  const W = 2.0, H = 1.25, D = 1.3, LEG = 0.44;
  const bumpBase = pixelBump();
  const mk = (rx, ry) => {
    const t = bumpBase.clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({
      color: CLAWD_COLOR, roughness: 0.56, metalness: 0.0, clearcoat: 0.22, clearcoatRoughness: 0.4,
      bumpMap: t, bumpScale: 0.11, emissive: new THREE.Color(1.0, 0.3, 0.05), emissiveIntensity: 0,
    });
  };
  const bodyMat = mk(8, 5);
  const limbMat = mk(2, 2);
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x050505, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, emissive: new THREE.Color(1.0, 0.55, 0.2), emissiveIntensity: 0 });

  // hips: everything above the legs; squash/stretch and lean happen here
  const hips = new THREE.Group();
  hips.position.y = LEG;
  root.add(hips);
  const body = new THREE.Group();
  hips.add(body);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 4, 0.07), bodyMat);
  shell.position.y = H / 2;
  body.add(shell);

  const eyes = [];
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.36, 0.06, 2, 0.02), eyeMat);
    e.position.set(s * 0.6, H * 0.66, D / 2 + 0.005);
    e.userData.noShadow = true;
    body.add(e);
    eyes.push(e);
  }

  // arms: a shoulder pivot on each flank; the nub slides out on telescoping blocks for strikes
  const arms = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * (W / 2 - 0.02), H * 0.36, 0);
    body.add(shoulder);
    const segs = [];
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.28 - i * 0.02, 0.4 - i * 0.03, 2, 0.03), limbMat);
      seg.visible = false;
      shoulder.add(seg);
      segs.push(seg);
    }
    const claw = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.36, 0.5, 3, 0.05), limbMat);
    claw.position.x = s * 0.17;
    shoulder.add(claw);
    const tip = new THREE.Object3D(); // attach point for trails / hit origin
    tip.position.x = s * 0.2;
    claw.add(tip);
    arms.push({ side: s, shoulder, claw, segs, tip });
  }

  const legs = [];
  const lx = [-0.76, -0.42, 0.42, 0.76];
  lx.forEach((x, i) => {
    const hip = new THREE.Group();
    const outer = i === 0 || i === 3;
    hip.position.set(x, LEG, outer ? 0.34 : -0.34);
    const leg = new THREE.Mesh(new RoundedBoxGeometry(0.19, LEG + 0.06, 0.24, 2, 0.035), limbMat);
    leg.position.y = -LEG / 2 + 0.03;
    hip.add(leg);
    root.add(hip);
    legs.push({ hip, phase: [0, 0.5, 0.5, 0][i], x, z: hip.position.z });
  });

  shadowed(root);
  return {
    kind: 'clawd', root, hips, body, shell, eyes, arms, legs,
    mats: { body: bodyMat, limb: limbMat, eye: eyeMat },
    dims: { W, H, D, LEG, height: LEG + H, chest: LEG + H * 0.5 },
    color: new THREE.Color(1.0, 0.42, 0.14),
  };
}

// ----------------------------------------------------------------------------------------------
// CODEX — the blue cloud-headed terminal pet: puffy head, dark screen with a ">_" prompt, small
// body with the same prompt on its chest, stubby limbs.
// ----------------------------------------------------------------------------------------------
export const CODEX_COLOR = new THREE.Color(0x3d72f6);

function promptTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 160);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 22;
  if (kind === 'chevron') {
    g.beginPath(); g.moveTo(52, 38); g.lineTo(108, 80); g.lineTo(52, 122); g.stroke();
  } else if (kind === 'cursor') {
    g.beginPath(); g.moveTo(146, 116); g.lineTo(210, 116); g.stroke();
  } else if (kind === 'ko') {
    g.lineWidth = 18;
    for (const x of [72, 184]) {
      g.beginPath(); g.moveTo(x - 26, 54); g.lineTo(x + 26, 106); g.moveTo(x + 26, 54); g.lineTo(x - 26, 106); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

function cloudGeometry() {
  // An ellipsoid pushed out along a ring of soft lumps: reads as the mascot's cloud outline from
  // the front and stays one continuous glossy surface from every other angle.
  const g = new THREE.SphereGeometry(1, 96, 64);
  const lumps = [
    [86, 0, 0.5, 13], [140, 0, 0.42, 15], [36, 0, 0.42, 15], [184, 0, 0.3, 13], [-4, 0, 0.3, 13],
    [226, 0, 0.26, 14], [314, 0, 0.26, 14], [270, 0, 0.1, 8],
    [112, -0.8, 0.3, 10], [62, -0.8, 0.3, 10], [200, -0.75, 0.2, 10], [-20, -0.75, 0.2, 10], [90, 0.55, 0.12, 8],
  ].map(([deg, z, amp, k]) => {
    const a = (deg * Math.PI) / 180;
    return { d: new THREE.Vector3(Math.cos(a), Math.sin(a), z).normalize(), amp, k };
  });
  const p = g.attributes.position, n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    n.fromBufferAttribute(p, i).normalize();
    let b = 0;
    for (const l of lumps) b += l.amp * Math.exp(-(1 - n.dot(l.d)) * l.k);
    p.setXYZ(i, n.x * 0.7 * (1 + b), n.y * 0.54 * (1 + b), n.z * 0.46 * (1 + b * 0.7));
  }
  g.computeVertexNormals();
  // the sphere's seam duplicates vertices; average their normals so the seam does not show
  const nn = g.attributes.normal, row = 97;
  for (let r = 0; r <= 64; r++) {
    const a = r * row, b = r * row + 96;
    const x = nn.getX(a) + nn.getX(b), y = nn.getY(a) + nn.getY(b), z = nn.getZ(a) + nn.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nn.setXYZ(a, x / l, y / l, z / l); nn.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

export function buildCodex() {
  const root = new THREE.Group();
  const skin = new THREE.MeshPhysicalMaterial({
    color: CODEX_COLOR, roughness: 0.32, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.18,
    emissive: new THREE.Color(0.2, 0.55, 1.0), emissiveIntensity: 0,
  });
  const skinDark = skin.clone();
  skinDark.color = new THREE.Color(0x2f5be0);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x070a1c, roughness: 0.1, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04 });
  const glow = (tex, k) => new THREE.MeshBasicMaterial({
    map: tex, color: new THREE.Color(0.42, 0.92, 1.0).multiplyScalar(k), transparent: true, toneMapped: false, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  });

  const LEG = 0.4;
  const hips = new THREE.Group();
  hips.position.y = LEG;
  root.add(hips);
  const body = new THREE.Group();
  hips.add(body);

  // torso
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.66, 0.6, 0.5, 5, 0.2), skinDark);
  torso.position.y = 0.3;
  body.add(torso);
  const chestGlyph = new THREE.Group();
  const cg1 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.21), glow(promptTexture('chevron'), 2.2));
  const cg2 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.21), glow(promptTexture('cursor'), 2.2));
  chestGlyph.add(cg1, cg2);
  chestGlyph.position.set(0, 0.31, 0.253);
  chestGlyph.traverse((o) => (o.userData.noShadow = true));
  body.add(chestGlyph);

  // head: a cloud of overlapping lobes, slightly flattened front to back
  const head = new THREE.Group();
  head.position.y = 1.08;
  body.add(head);
  const cloud = new THREE.Mesh(cloudGeometry(), skin);
  head.add(cloud);
  const screen = new THREE.Mesh(new RoundedBoxGeometry(0.96, 0.6, 0.3, 5, 0.14), glass);
  screen.position.set(0, -0.03, 0.34);
  head.add(screen);
  const face = new THREE.Group();
  face.position.set(0, -0.03, 0.495);
  const chevron = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), glow(promptTexture('chevron'), 3.2));
  const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), glow(promptTexture('cursor'), 3.2));
  const ko = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), glow(promptTexture('ko'), 3.2));
  ko.visible = false;
  face.add(chevron, cursor, ko);
  face.traverse((o) => (o.userData.noShadow = true));
  head.add(face);

  // arms
  const arms = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.37, 0.5, 0);
    body.add(shoulder);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.26, 6, 14), skin);
    arm.position.y = -0.2;
    shoulder.add(arm);
    const tip = new THREE.Object3D();
    tip.position.y = -0.42;
    shoulder.add(tip);
    shoulder.rotation.z = s * 0.5;
    arms.push({ side: s, shoulder, arm, tip });
  }
  // legs
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.17, LEG + 0.06, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.2, 6, 14), skinDark);
    leg.position.y = -0.24;
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), skinDark);
    foot.scale.set(1, 0.62, 1.3);
    foot.position.set(0, -0.385, 0.05);
    hip.add(leg, foot);
    root.add(hip);
    legs.push({ hip, side: s });
  }

  shadowed(root);
  return {
    kind: 'codex', root, hips, body, torso, head, screen, face, chevron, cursor, ko, chestGlyph, arms, legs,
    mats: { skin, skinDark, glass, glyphs: [chevron.material, cursor.material, ko.material, cg1.material, cg2.material] },
    dims: { LEG, height: 2.05, chest: 1.0 },
    color: new THREE.Color(0.25, 0.6, 1.0),
  };
}
