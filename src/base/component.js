import React from 'react';
import PropTypes from 'prop-types';

/**
 * Anything that requires an AudioContext is a RComponent
 *
 * @class      RComponent (name)
 */
export default class RComponent extends React.Component {
  componentWillMount() {
    if (!this.context.audio) throw new ReferenceError('RComponent needs to be a child of a RAudioContext');
  }

  // Every update can change the shape of the graph (an RPipeline can pick a
  // different neighbour for one of its children, a node can re-create its
  // AudioNode etc.), so after each update the registry re-synchronises the
  // connections of the whole graph. That is a no-op unless the graph changed.
  componentDidMount() {
    this.syncGraph();
  }

  componentDidUpdate() {
    this.syncGraph();
  }

  componentWillUnmount() {
    this.unregisterFromGraph();
  }

  /**
   * Removes the component's entry from the node registry, so that nothing can
   * resolve to the nodes of a component which is no longer mounted.
   */
  unregisterFromGraph() {
    const nodes = this.context.nodes;
    const identifier = this.props.identifier;

    if (!nodes) return;

    if (identifier !== undefined) nodes.delete(identifier);

    if (typeof nodes.unregisterNode === 'function') nodes.unregisterNode(this);
  }

  syncGraph() {
    const nodes = this.context.nodes;

    if (nodes && typeof nodes.syncAll === 'function') nodes.syncAll();
  }

  render() { return null; }
}

RComponent.contextTypes = {
  audio: PropTypes.instanceOf(window.AudioContext || window.webkitAudioContext),
  nodes: PropTypes.instanceOf(Map),
  debug: PropTypes.bool
};
