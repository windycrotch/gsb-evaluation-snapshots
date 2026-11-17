import React from 'react';
import RComponent from './component.js';

import {
  trackConnection,
  getConnections,
  getIncomingConnections,
  removeConnection,
  clearConnections
} from './connection-registry.js';

const sameArguments = (a, b) => {
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

// Warnings are only useful for the interesting failures; an
// InvalidAccessError just means the connection was already gone (e.g. a
// scheduled source removes its connections when it stops playing).
const warn = error => {
  if (error && error.name === 'InvalidAccessError') return;
  console.warn(error); // eslint-disable-line no-console
};

/**
 * Any RComponent that corresponds to an AudioNode is a RAudioNode
 *
 * @class      RAudioNode (name)
 */
export default class RAudioNode extends RComponent {
  constructor(props) {
    super(props);
    // internal AudioNode instance
    this.node = null;
    // dictionary of AudioNode parameters (either AudioParams or object properties)
    this.params = {};
    // AudioNodes which are currently connected into this node (from the `parent` prop)
    this.connectedParents = [];
    this.connectToAllDestinations = this.connectToAllDestinations.bind(this);
    this.syncConnections = this.syncConnections.bind(this);
    this.setParam = this.setParam.bind(this);
  }

  componentWillMount() {
    super.componentWillMount();
    // make the node available to the graph as early as possible
    if (this.context.nodes && typeof this.context.nodes.registerNode === 'function') {
      this.context.nodes.registerNode(this);
    }
  }

  // recursively builds up a list of nodes pointed to by IDs or lists of IDs
  flattenPointers(destinations, flattened = []) {
    for (let element of destinations) {
      if (Array.isArray(element)) {
        this.flattenPointers(element, flattened);
      } else if (typeof element === 'symbol') {
        const pointer = this.context.nodes.get(element);

        // a pointer can lead to a list of other pointers (e.g. the inputs of an RSplit)
        if (Array.isArray(pointer)) this.flattenPointers(pointer, flattened);
        // keep the slot (as undefined) so that the destination indices stay stable
        else flattened.push(pointer);
      } else {
        flattened.push(element);
      }
    }

    return flattened;
  }

  /**
   * Generates arguments for AudioNode.connect
   * Useful because we can, for instance, override the channel assignment logic for ChannelSplitter etc.
   *
   * @param      {function} destination The AudioNode to connect to
   * @param      {number} destinationIndex The index of the AudioNode among other destinations
   * @param      {string|null} toParam The name of the AudioParam to connect to (or undefined)
   * @param      {number} fromChannel The index of the chosen output channel of this node (default is 0)
   * @param      {number} toChannel The index of the chosen input channel of the destination node (default is 0)
   */
  getConnectionArguments(destination, destinationIndex, toParam, fromChannel = 0, toChannel = 0) {
    const connectTarget = toParam ? destination[toParam] : destination;

    return [ connectTarget ].concat(toParam ? [] : [ fromChannel, toChannel ]);
  }

  /**
   * Works out the arguments of a single connection from this node to `destination`.
   * The `owner` is the AudioNode which the connection belongs to – it's the
   * destination itself, unless we're connecting to one of its AudioParams.
   */
  resolveConnection(destination, destinationIndex) {
    if (!destination) return null;

    const toParam = this.props.connectToParam;
    const args = this.getConnectionArguments(
      destination,
      destinationIndex,
      toParam,
      this.props.connectFromChannel,
      this.props.connectToChannel);

    const target = args[0];

    if (!target) return null;

    return {
      target,
      owner: toParam ? destination : target,
      args
    };
  }

  /**
   * Resolves the connections which this node should currently have from its
   * `destination` prop (and the `disconnected` flag). Unresolvable pointers are
   * skipped, so a node never connects to something that isn't mounted.
   *
   * @return     {Array|null}  the connections, or `null` if the destinations could not be resolved
   */
  resolveDestinations(destinationFunction) {
    if (!destinationFunction || this.props.disconnected) return [];

    let destinations;

    try {
      destinations = destinationFunction();
    } catch (e) {
      // the getter can only fail if the graph is momentarily inconsistent;
      // leave the node's connections alone rather than tearing them down
      return null;
    }

    if (!(destinations instanceof Array)) destinations = [ destinations ];

    const connections = [];

    this.flattenPointers(destinations).forEach((destination, destinationIndex) => {
      const connection = this.resolveConnection(destination, destinationIndex);

      if (!connection) return;

      // connecting the exact same target with the same channel assignment
      // twice would only duplicate the signal (e.g. in an RCycle), so the
      // duplicate is dropped – different channel assignments are kept
      const duplicate = connections.some(existing =>
        existing.target === connection.target &&
        sameArguments(existing.args, connection.args));

      if (!duplicate) connections.push(connection);
    });

    return connections;
  }

  /**
   * Resolves the AudioNodes which are declared to feed into this node,
   * as reported by the `parent` prop.
   */
  resolveParents() {
    const getParent = this.props.parent;

    if (typeof getParent !== 'function') return [];

    let parents;

    try {
      parents = getParent();
    } catch (e) {
      return [];
    }

    if (!parents) return [];
    if (!(parents instanceof Array)) parents = [ parents ];

    return this.flattenPointers(parents)
      .filter(parent => parent && parent !== this.node);
  }

  /**
   * Removes the connections which an old parent used to make into this node
   * when the node's parent changes, leaving the parent's other connections
   * (e.g. to this node's siblings) untouched.
   */
  syncParents() {
    const parents = this.resolveParents();

    this.connectedParents
      .filter(parent => !parents.includes(parent))
      .forEach(parent => {
        getConnections(parent)
          .filter(connection => connection.owner === this.node || connection.target === this.node)
          .forEach(connection => {
            try {
              parent.disconnect(connection.target);
            } catch (e) {
              warn(e);
            }

            removeConnection(parent, connection.target);
          });
      });

    this.connectedParents = parents;
  }

  /**
   * Brings this node's connections in line with its current props.
   *
   * Stale connections are disconnected first (by target, so that any other
   * connections the node has are left alone) and the missing ones are made
   * afterwards. Calling this repeatedly with the same graph is a no-op.
   *
   * @param      {Function}  destinationFunction  The destinations getter, defaults to the `destination` prop
   * @param      {AudioNode}  webAudioNode  The AudioNode to synchronise, defaults to this component's node
   */
  syncConnections(destinationFunction = this.props.destination, webAudioNode = this.node) {
    const node = webAudioNode;

    if (!node) return;

    const desired = this.resolveDestinations(destinationFunction);

    // the destinations can't be resolved right now – don't touch the graph
    if (!desired) return;

    // 1. disconnect whatever is no longer wanted.
    // `AudioNode.disconnect(target)` drops every connection to that target, so
    // a target is only disconnected once, even if it had several entries
    // (e.g. with different channel assignments).
    const staleTargets = [];

    getConnections(node).forEach(connection => {
      const stillWanted = desired.some(candidate =>
        candidate.target === connection.target &&
        sameArguments(candidate.args, connection.args));

      if (!stillWanted && !staleTargets.includes(connection.target)) {
        staleTargets.push(connection.target);
      }
    });

    staleTargets.forEach(target => {
      try {
        node.disconnect(target);
      } catch (e) {
        warn(e);
      }

      removeConnection(node, target);
    });

    // 2. connect whatever is missing
    desired.forEach(connection => {
      const alreadyConnected = getConnections(node).some(existing =>
        existing.target === connection.target &&
        sameArguments(existing.args, connection.args));

      if (alreadyConnected) return;

      try {
        node.connect(...connection.args);
      } catch (e) {
        warn(e);
        return;
      }

      trackConnection(node, connection.target, connection.owner, connection.args);
    });

    if (node === this.node) this.syncParents();
  }

  /**
   * Forgets the connections of an AudioNode which is being replaced by a new
   * one (e.g. when a source re-creates its node after a prop change), so that
   * the old edges can't accumulate or point at a dead node.
   *
   * @param      {AudioNode}  oldNode  The AudioNode which is being replaced
   */
  disposeNode(oldNode) {
    if (!oldNode) return;

    getIncomingConnections(oldNode).forEach(({ source, target }) => {
      try {
        source.disconnect(target);
      } catch (e) {
        warn(e);
      }

      removeConnection(source, target);
    });

    clearConnections(oldNode);

    try {
      oldNode.disconnect();
    } catch (e) {
      warn(e);
    }
  }

  /**
   * Connects the given AudioNode to this RAudioNode's destinations.
   * Kept for the components which re-create their AudioNode (e.g. scheduled
   * sources); it simply reconciles the connections.
   *
   * @param      {function} destinationFunction The function that will return the destinations
   * @param      {AudioNode}  webAudioNode  The web audio node
   */
  connectToAllDestinations(destinationFunction, webAudioNode) {
    this.syncConnections(destinationFunction, webAudioNode || this.node);
  }

  componentWillReceiveProps(nextProps) {
    this.updateParams(nextProps);
  }

  componentWillUpdate(nextProps, nextState) {
    // update the node's record in the node registry
    if (this.props.identifier !== nextProps.identifier) {
      this.context.nodes.delete(this.props.identifier);
      this.context.nodes.set(nextProps.identifier, this.node);
    }
  }

  /**
   * Removes all connections into and out of the node when it unmounts.
   *
   * The outgoing connections all belong to this node, so they can be dropped
   * with a single `disconnect()`. The incoming ones have to be removed one
   * target at a time, so that the parents' connections to any siblings are
   * left intact.
   */
  componentWillUnmount() {
    const node = this.node;

    if (node) {
      // detach from the nodes which point at this one
      getIncomingConnections(node).forEach(({ source, target }) => {
        try {
          source.disconnect(target);
        } catch (e) {
          warn(e);
        }

        removeConnection(source, target);
      });

      // and drop this node's own outgoing connections
      clearConnections(node);

      try {
        node.disconnect();
      } catch (e) {
        warn(e);
      }
    }

    this.connectedParents = [];
    this.node = null;

    // removes the registry entry and unregisters the component
    super.componentWillUnmount();
  }

  componentDidMount() {
    super.componentDidMount();
    this.syncConnections();
  }

  resolveTransitionProps(props, propName) {
    const transitionTime = typeof props.transitionTime === 'number'
      ? props.transitionTime
      : props.transitionTime ? props.transitionTime[propName] : null;

    const transitionCurve = typeof props.transitionCurve === 'string'
      ? props.transitionCurve
      : props.transitionCurve ? props.transitionCurve[propName] : null;

    return [ transitionTime, transitionCurve ];
  }

  // updates only Web Audio-related parameters
  // (both AudioParams and regular properties)
  updateParams(props) {
    if (!this.params) return;

    for (let p in this.params) {
      if (!(p in props)) continue;

      const [ transitionTime, transitionCurve ] = this.resolveTransitionProps(props, p);

      if (this.node[p] instanceof AudioParam) {
        this.setParam(this.node[p], props[p], transitionTime, transitionCurve);
      } else if (this.node.parameters && this.node.parameters.has(p)) {
        let param = this.node.parameters.get(p);
        this.setParam(param, props[p], transitionTime, transitionCurve);
      } else if (p in this.node) {
        // some browsers (e.g. Chrome) will try to set channelCount and throw an error
        // since we can't use Object.getOwnPropertyDescriptor on the AudioNodes
        // we simply wrap the action in a try-catch
        try {
          if (this.node[p] !== props[p]) this.node[p] = props[p];
        } catch(e) {
          console.warn(`Tried setting ${p} on node`, this.node); // eslint-disable-line no-console
        }
      }
    }
  }

  setParam(param, value, transitionTime, transitionCurve) {
    if (transitionCurve) {
      const fn = `${transitionCurve}RampToValueAtTime`;
      // `exponentialRamp` doesn't seem to work on Firefox, so fall back to linear
      try {
        param[fn](value, transitionTime);
      } catch (e) {
        param['linearRampToValueAtTime'](value, transitionTime);
      }
    } else {
      param.setValueAtTime(value, transitionTime || this.context.audio.currentTime);
    }
  }

  render() {
    if (this.context.debug) {
      return (
        <li>
          <div>
            <strong>
              {this.constructor.name} <em>{this.props.name || ''}</em>
              <sup><mark>{this.props.disconnected && 'disconnected' || ''}</mark></sup>
            </strong>
            <div>{ this.props.connectToParam ? <span> connects to <em>{this.props.connectToParam}</em></span> : null }</div>
          </div>
          <ul>
            {
              Object.keys(this.params).map((p, pi) => {
                if (!this.props[p] && this.props[p] !== 0) return null;

                let param = this.props[p];
                if (typeof this.props[p] === 'boolean') param = this.props[p].toString();

                if (!(['number', 'string', 'boolean'].includes(typeof this.props[p]))) {
                  param = param.constructor.name;
                }

                return <li key={pi}>{p}: <code>{param}</code></li>;
              })
            }
          </ul>
        </li>
      );
    }

    return null;
  }
}
