/** Helpers that run our export through the OFFICIAL Spine 4.3 runtime (@esotericsoftware/spine-core). */
import * as spine from '@esotericsoftware/spine-core';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { exportSpineJson } from '../src/core/export/spineJson';
import { attachmentPictures } from '../src/core/sequence';
import type { Project } from '../src/core/model';

export const S = spine as any;

class FakeTexture extends S.Texture {
  constructor(image: unknown) {
    super(image);
  }
  setFilters() {}
  setWraps() {}
  dispose() {}
}

/** Loads exported JSON + atlas text with the official `SkeletonJson`. Throws exactly like the real loader does. */
export function loadOfficial(json: unknown, atlasText: string, scale = 1) {
  const atlas = new S.TextureAtlas(atlasText);
  for (const page of atlas.pages) page.setTexture(new FakeTexture({ width: page.width, height: page.height }));
  const loader = new S.AtlasAttachmentLoader(atlas);
  const sj = new S.SkeletonJson(loader);
  sj.scale = scale;
  return sj.readSkeletonData(JSON.stringify(json));
}

/**
 * The official runtime starts every bone with an all-zero world matrix; ours starts with the identity. They differ only for what
 * is read before it is updated: a path constraint that follows a path skinned to bones (not to the slot's own bone) looks at the
 * slot bone's matrix to pick the sign of its rotation offset, and on the very first update of a fresh skeleton the official
 * runtime sees zeros (the sign flips for that one frame); every later update, in a game or in the editor, sees the previous
 * frame's matrix and both agree. The parity tests compare first updates of fresh skeletons, so they start ours the same way.
 */
export function startLikeOfficial(skeleton: { bones: { a: number; b: number; c: number; d: number }[] }) {
  for (const b of skeleton.bones) b.a = b.b = b.c = b.d = 0;
}

/** Image names referenced by any attachment (what the atlas must contain). */
export function usedImages(project: Project) {
  const used = new Set<string>();
  for (const skin of project.skeleton.skins) {
    for (const slot of Object.values(skin.attachments)) {
      for (const att of Object.values(slot)) {
        for (const image of attachmentPictures(att)) used.add(image);
      }
    }
  }
  return project.images.filter((i) => used.has(i.name)).map((i) => ({ name: i.name, width: i.width, height: i.height }));
}

/** Exports `project` the way the editor does and loads it with the official runtime. */
export function exportAndLoad(project: Project, options: Parameters<typeof exportSpineJson>[1] = {}) {
  const json = exportSpineJson(project.skeleton, options);
  const pages = packAtlas(usedImages(project), { maxSize: 2048, padding: 2 });
  const atlasText = writeAtlas(pages, (i) => `atlas${i}.png`);
  return { json, skeletonData: loadOfficial(json, atlasText), atlasText };
}

/** Loads binary data (.skel) with the official `SkeletonBinary`. */
export function loadOfficialBinary(bytes: Uint8Array, atlasText: string) {
  const atlas = new S.TextureAtlas(atlasText);
  for (const page of atlas.pages) page.setTexture(new FakeTexture({ width: page.width, height: page.height }));
  const loader = new S.AtlasAttachmentLoader(atlas);
  const sb = new S.SkeletonBinary(loader);
  return sb.readSkeletonData(bytes);
}
