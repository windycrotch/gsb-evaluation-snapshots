import type { Graph } from './graph';

export interface LoadGraphMessage {
  type: 'loadGraph';
  graph: Graph;
  /**
   * Monotonic id of this load, assigned by the main-thread sync controller.
   * The worklet echoes it back on graphLoaded/error so stale replies can be
   * told apart from the latest in-flight load.
   */
  revision: number;
}

export interface SetParamMessage {
  type: 'setParam';
  id: string;
  param: string;
  value: number | string;
}

export interface GraphLoadedMessage {
  type: 'graphLoaded';
  success: true;
  revision: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  revision: number;
}

export interface ScopeFrame {
  id: string;
  samples: number[];
}

export interface ScopeDataMessage {
  type: 'scopeData';
  frames: ScopeFrame[];
}

export type WorkletMessage =
  LoadGraphMessage | SetParamMessage | GraphLoadedMessage | ErrorMessage | ScopeDataMessage;
