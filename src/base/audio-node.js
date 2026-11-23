import React from 'react';
import RComponent from './component.js';
import AudioNodeRegistry from './node-registry.js';

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
    this.connectToAllDestinations = this.connectToAllDestinations.bind(this);
    this.setParam = this.setParam.bind(this);
    // identifiers previously held by this component (identifier changes)
    this._previousIdentifiers = [];
  }

  // recursively builds up a list of nodes pointed to by IDs or lists of IDs.
  // missing targets stay as their Symbol so the registry can defer connecting
  // until they register, instead of silently dropping the connection.
  flattenPointers(destinations, flattened = []) {
    for (let element of destinations) {
      if (Array.isArray(element)) {
        this.flattenPointers(element, flattened);
      } else if (typeof element === 'symbol') {
        const registered = this.context.nodes.get(element);
        flattened.push(registered === undefined ? element : registered);
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
   * Connects the given AudioNode to this RAudioNode's destinations.
   *
   * Destinations that are still unregistered Symbols are handed to the
   * registry as pending connections and are automatically fulfilled when the
   * target registers, so a node can never permanently lose a connection to a
   * sibling that registers later in the same render pass.
   *
   * @param      {function} destinationFunction The function that will return the destinations
   * @param      {AudioNode}  webAudioNode  The web audio node
   */
  connectToAllDestinations(destinationFunction, webAudioNode) {
    const registry = this.context.nodes;
    registry.safeDisconnect(webAudioNode);
    registry.dropSource(webAudioNode);

    if (destinationFunction && !this.props.disconnected) {
      let destinations = destinationFunction();

      if (!(destinations instanceof Array)) destinations = [ destinations ];

      this.flattenPointers(destinations).forEach((destination, di) => {
        if (destination === undefined || destination === null) return;

        const connectArgs = this.getConnectionArguments(
          destination,
          di,
          this.props.connectToParam,
          this.props.connectFromChannel,
          this.props.connectToChannel);

        if (typeof destination === 'symbol') {
          // target not registered yet: skip now, the registry reconnects
          // automatically as soon as the target registers
          registry.requestConnect(webAudioNode, destination, connectArgs, this.props.identifier);
        } else {
          registry.connectToNode(webAudioNode, destination, connectArgs, this.props.identifier);
        }
      });
    }
  }

  componentWillMount() {
    super.componentWillMount();
  }

  /**
   * Registers the current internal AudioNode under the component's identifier.
   * Always go through this (or the registry directly) rather than `nodes.set`,
   * so that instance replacement (source nodes re-created after `ended`)
   * refreshes the registry and every inbound connection atomically.
   */
  registerNode() {
    this.context.nodes.register(this.props.identifier, this.node);
  }

  componentWillReceiveProps(nextProps) {
    this.updateParams(nextProps);
  }

  componentWillUpdate(nextProps, nextState) {
    // move the registry entry (and all pending/inbound bookkeeping) to the
    // new identifier. The old key is always removed, even across rapid
    // successive identifier changes, so only the newest key survives.
    if (this.props.identifier !== nextProps.identifier) {
      this.context.nodes.replaceKey(this.props.identifier, nextProps.identifier, this.node);
      this._previousIdentifiers.push(this.props.identifier);
    }
  }

  // we use DidUpdate to connect to new destinations,
  // because WillUpdate might get called before the new destinations are ready
  componentDidUpdate(prevProps, prevState) {
    if (prevProps.destination !== this.props.destination ||
        prevProps.identifier !== this.props.identifier) {
      this.connectToAllDestinations(this.props.destination, this.node);
    }
  }

  componentWillUnmount() {
    const registry = this.context.nodes;

    registry.safeDisconnect(this.node);
    // only remove the key if it still points at this component's instance:
    // a re-instantiated or re-identified node must not be clobbered by cleanup
    registry.unregister(this.props.identifier, this.node);
    this._previousIdentifiers.forEach(oldKey => registry.unregister(oldKey));
    this._previousIdentifiers.length = 0;
    registry.dropSource(this.node);
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

  componentDidMount() {
    this.connectToAllDestinations(this.props.destination, this.node);
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

export { AudioNodeRegistry };
