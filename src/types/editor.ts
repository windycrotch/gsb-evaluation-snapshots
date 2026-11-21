import { Object3D } from 'three';
import { Animation, Sound } from './animations';
import type { WebElement } from './web';

export type AssetType = '3d' | '2d' | 'audio' | 'video';

export interface PhysicsProperties {
  enabled: boolean;
  mass: number;
  velocity: [number, number, number];
  acceleration: [number, number, number];
  useGravity: boolean;
  isKinematic: boolean;
  linearDamping?: number;
  isTrigger?: boolean;
  collider?: {
    type: 'box' | 'sphere' | 'cylinder';
    size: [number, number, number];
  };
}

export interface CharacterController {
  enabled: boolean;
  speed: number;
  onCompleteSceneId?: string;
  jumpForce: number;
  isGrounded: boolean;
  canJump: boolean;
  mode?: 'legacy' | 'fps' | 'rpg';
  cameraHeight?: number;
  cameraDistance?: number;
  lookSensitivity?: number;
}

export interface SceneObject {
  id: string;
  name: string;
  type: string;
  object: Object3D;
  properties: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    visible?: boolean;
    color?: string;
    intensity?: number;
    distance?: number;
    angle?: number;
    penumbra?: number;
    decay?: number;
    fov?: number;
    aspect?: number;
    near?: number;
    far?: number;
    receiveShadow?: boolean;
    castShadow?: boolean;
    animations?: Animation[];
    sounds?: Sound[];
    texture?: string;
    map?: string;
    normalMap?: string;
    roughnessMap?: string;
    metalnessMap?: string;
    metalness?: number;
    roughness?: number;
    opacity?: number;
    materialType?: 'standard' | 'basic' | 'phong' | 'lambert';
    modelData?: string;
    text3d?: {
      text: string;
      size: number;
      depth: number;
    };
    tween?: {
      enabled: boolean;
      property: 'position' | 'rotation' | 'scale' | 'opacity';
      target: [number, number, number];
      opacity: number;
      duration: number;
      easing: 'linear' | 'smooth' | 'out';
      repeat: boolean;
      yoyo: boolean;
    };
    float?: {
      enabled: boolean;
      speed: number;
      height: number;
      rotation: number;
    };
    modelAnimation?: {
      clipIndex: number;
      autoPlay: boolean;
      loop: boolean;
      speed: number;
      onCompleteSceneId?: string;
    };
    className?: string;
    tags?: string[];
    script?: string;
    web?: WebElement;
    physics?: PhysicsProperties;
    characterController?: CharacterController;
    pathFollower?: {
      enabled: boolean;
      algorithm: 'astar' | 'dijkstra' | 'q';
      speed: number;
      cellSize: number;
      faceDirection: boolean;
      avoidObstacles?: boolean;
    };
    postProcessing?: {
      bloom?: {
        enabled: boolean;
        intensity: number;
        threshold: number;
        radius: number;
      };
      dof?: {
        enabled: boolean;
        focusDistance: number;
        focalLength: number;
        bokehScale: number;
      };
      vignette?: {
        enabled: boolean;
        darkness: number;
        offset: number;
      };
    };
  };
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  url: string;
  thumbnail?: string;
  metadata?: {
    size?: number;
    format?: string;
    duration?: number;
  };
}

export interface Component {
  id: string;
  name: string;
  type: string;
  icon: string;
  properties: Record<string, unknown>;
}