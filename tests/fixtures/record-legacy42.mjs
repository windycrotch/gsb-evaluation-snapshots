/**
 * Records `legacy42.golden.json`: what the OFFICIAL Spine 4.2 runtime computes for `legacy42.json`.
 *
 *   node tests/fixtures/record-legacy42.mjs <folder of an extracted @esotericsoftware/spine-core 4.2.x package> [--write]
 *
 * Without `--write` the recording is compared with the stored golden file (this is how `tests/legacy.test.ts` knows the golden
 * numbers are honest); with `--write` the golden file is replaced. The runtime itself is NOT part of this repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node record-legacy42.mjs <spine-core 4.2 package folder> [--write]');
const S = await import(pathToFileURL(join(dir, 'dist/esm/spine-core.mjs')).href);

const here = new URL('.', import.meta.url);
const json = JSON.parse(readFileSync(new URL('legacy42.json', here), 'utf8'));

const atlasText = `page.png
size:256,256
filter:Linear,Linear
body
bounds:0,0,64,64
mesh
bounds:64,0,64,64
stripe
bounds:128,0,32,64
`;

class FakeTexture extends S.Texture {
  constructor(image) {
    super(image);
  }
  setFilters() {}
  setWraps() {}
  dispose() {}
}
const atlas = new S.TextureAtlas(atlasText);
for (const page of atlas.pages) page.setTexture(new FakeTexture({ width: page.width, height: page.height }));
const data = new S.SkeletonJson(new S.AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.stringify(json));

const r6 = (v) => Math.round(v * 1e6) / 1e6;

function snapshot(skin, animation, t) {
  const sk = new S.Skeleton(data);
  if (skin) sk.setSkinByName(skin);
  sk.setToSetupPose();
  if (animation) {
    const state = new S.AnimationState(new S.AnimationStateData(data));
    state.setAnimation(0, animation, false);
    state.update(t);
    state.apply(sk);
  }
  sk.updateWorldTransform(S.Physics.update);
  const bones = {};
  for (const b of sk.bones) if (b.isActive()) bones[b.data.name] = [b.a, b.b, b.c, b.d, b.worldX, b.worldY].map(r6);
  const slots = {};
  for (const s of sk.slots) {
    slots[s.data.name] = { attachment: s.attachment ? s.attachment.name : null, color: [s.color.r, s.color.g, s.color.b, s.color.a].map(r6), dark: s.darkColor ? [s.darkColor.r, s.darkColor.g, s.darkColor.b].map(r6) : null };
  }
  return { bones, slots, drawOrder: sk.drawOrder.map((s) => s.data.name) };
}

const out = { runtime: S.SkeletonData ? '4.2' : '?', poses: [] };
for (const skin of [null, 'alt']) {
  for (const [animation, times] of [[null, [0]], ['still', [0]], ['idle', [0.13, 0.37, 0.7, 1.13]]]) {
    for (const t of times) out.poses.push({ skin, animation, time: t, ...snapshot(skin, animation, t) });
  }
}
const text = JSON.stringify(out, null, 1) + '\n';
const goldenUrl = new URL('legacy42.golden.json', here);
if (process.argv.includes('--write')) {
  writeFileSync(goldenUrl, text);
  console.log('wrote legacy42.golden.json:', out.poses.length, 'poses');
} else {
  const same = readFileSync(goldenUrl, 'utf8') === text;
  console.log(same ? 'golden file matches the 4.2 runtime' : 'GOLDEN FILE DIFFERS from what the 4.2 runtime computes');
  process.exit(same ? 0 : 1);
}
