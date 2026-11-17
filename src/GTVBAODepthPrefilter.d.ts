import type { Node, Renderer, TextureNode } from "three/webgpu";

export const GTVBAO_DEPTH_MIP_COUNT: 5;

export function sceneDepthToLinearDepth(
  depth: Node,
  cameraNear: Node,
  cameraFar: Node,
  isOrthographicCamera: boolean,
  logarithmicDepthBuffer: boolean
): Node<"float">;

export function depthTexelOfAoTexel(
  aoTexel: Node,
  depthResolution: Node,
  aoResolution: Node
): Node<"vec2">;

export function depthTexelOfAoTexelJS(
  aoTexelX: number,
  aoTexelY: number,
  depthWidth: number,
  depthHeight: number,
  aoWidth: number,
  aoHeight: number
): [number, number];

export default class GTVBAODepthPrefilter {
  readonly mipTextureNodes: TextureNode[];

  constructor(
    depthNode: Node,
    cameraNear: Node,
    cameraFar: Node,
    depthRange: Node,
    isOrthographicCamera?: boolean
  );
  setLogarithmicDepthBuffer(value: boolean): void;
  setCamera(
    cameraNear: Node,
    cameraFar: Node,
    isOrthographicCamera: boolean
  ): void;
  setSize(width: number, height: number, depthWidth: number, depthHeight: number): void;
  invalidate(): void;
  release(): void;
  compute(renderer: Renderer): void;
  dispose(): void;
}
