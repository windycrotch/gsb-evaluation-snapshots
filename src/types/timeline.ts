export type TimelineProperty =
  | 'position.x' | 'position.y' | 'position.z'
  | 'rotation.x' | 'rotation.y' | 'rotation.z'
  | 'scale.x' | 'scale.y' | 'scale.z'
  | 'web.x' | 'web.y' | 'web.rotation' | 'web.scale' | 'web.opacity'
  | 'media';

export interface TimelineKeyframe {
  id: string;
  time: number;
  value: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'smooth';
  deviceValues?: { tablet?: number; mobile?: number };
}

export type TimelineDevice = 'desktop' | 'tablet' | 'mobile';

export interface TimelineTrack {
  id: string;
  targetId: string;
  property: TimelineProperty;
  keyframes: TimelineKeyframe[];
}

export interface TimelineClip {
  id: string;
  targetId: string;
  clipIndex: number;
  start: number;
  duration: number;
}

export interface TimelineSound {
  id: string;
  targetId: string;
  soundId: string;
  start: number;
  duration: number;
}

export interface SceneTimeline {
  duration: number;
  trigger: 'start' | 'key' | 'scroll';
  key: string;
  tracks: TimelineTrack[];
  clips?: TimelineClip[];
  sounds?: TimelineSound[];
}
