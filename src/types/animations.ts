import { Vector3 } from 'three';

export type AnimationType = 'rotation' | 'movement' | 'teleport' | 'characterAnimation';
export type TriggerType = 'none' | 'key' | 'mouse' | 'mouseWheel' | 'collision' | 'proximity';

export interface Trigger {
  type: TriggerType;
  key?: string;
  mouseButton?: number;
  mouseWheelDirection?: 'up' | 'down' | 'both';
  targetId?: string;
  distance?: number;
}

export interface Animation {
  id: string;
  type: AnimationType;
  targetId: string;
  autoPlay: boolean;
  onCompleteSceneId?: string;
  trigger?: Trigger;
  params: {
    duration: number;
    loop: boolean;
    startPosition?: number[] | Vector3;
    endPosition?: number[] | Vector3;
    rotationSpeed?: { x: number; y: number; z: number } | Vector3;
    movementSpeed?: { x: number; y: number; z: number } | Vector3;
    animationName?: string;
  };
}

export interface Sound {
  id: string;
  name: string;
  url: string;
  autoPlay: boolean;
  volume: number;
  loop: boolean;
  trigger?: Trigger;
}

export interface Ground {
  id: string;
  type: 'plane' | 'box';
  size: [number, number];
  texture?: string;
  color: string;
  receiveShadow: boolean;
}