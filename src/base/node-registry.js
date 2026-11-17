import React from 'react';

/**
 * A Map of all the nodes in the graph which knows how to re-synchronise the
 * connections of every live r-audio node.
 *
 * The Web Audio API doesn't let us inspect the incoming connections of an
 * AudioNode, so the library keeps its own record of the graph's edges
 * (see `connection-registry.js`). Whenever the shape of the graph changes,
 * every live node re-evaluates the connections it should currently have and
 * only adds or removes the edges which actually differ.
 *
 * @class      NodeRegistry (name)
 */
export default class NodeRegistry extends Map {
  constructor(...args) {
    super(...args);
    // all the currently mounted RAudioNode instances
    this._instances = new Set();
    // guards against re-entrant synchronisation
    this._syncing = false;
  }

  registerNode(instance) {
    if (instance) this._instances.add(instance);
  }

  unregisterNode(instance) {
    this._instances.delete(instance);
  }

  /**
   * Brings the connections of every live node in line with the current graph.
   */
  syncAll() {
    if (this._syncing) return;

    this._syncing = true;

    try {
      // copy the instances, as syncing may cause nodes to unmount in rare cases
      Array.from(this._instances).forEach(instance => {
        if (instance && typeof instance.syncConnections === 'function') {
          instance.syncConnections();
        }
      });
    } finally {
      this._syncing = false;
    }
  }
}
