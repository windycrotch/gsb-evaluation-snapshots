import type { Graph } from './graph';

export interface LoadGraphMessage {
  type: 'loadGraph';
  graph: Graph;
  /**
   * Monotonic graph version. Every structural rebuild gets a new version;
   * parameter edits carry the version of the graph instance they belong to.
   * The engine uses it to ignore messages from graphs it has moved past.
   */
  version: number;
}

export interface SetParamMessage {
  type: 'setParam';
  id: string;
  param: string;
  value: number | string;
  /**
   * Version of the graph this parameter belongs to. The engine drops the
   * message when it does not match the currently loaded version, so an edit
   * made against a graph that has since been replaced can never touch a
   * same-named module of a newer graph.
   */
  version: number;
}

export interface GraphLoadedMessage {
  type: 'graphLoaded';
  success: true;
  /** Version of the graph the engine just committed. */
  version: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  /**
   * Version of the graph that failed to load. The UI can tell a stale error
   * (from an already-superseded attempt) from the latest one.
   */
  version: number;
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
