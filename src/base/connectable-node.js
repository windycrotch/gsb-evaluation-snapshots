import React from 'react';
import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be connected to is a RConnectableNode
 *
 * RAudioNode.componentWillUnmount already takes care of disconnecting the
 * node itself and asking every upstream parent to disconnect from it.
 * The parent lookup goes through the context.nodes registry, so parents
 * that have already been unmounted are simply skipped. This class remains
 * as the semantic marker used by the graph builders (RPipeline, RSplit...)
 * to tell connectable nodes apart.
 *
 * @class      RConnectableNode (name)
 */
export default class RConnectableNode extends RAudioNode {
  componentWillUnmount() {
    super.componentWillUnmount();
  }
}
