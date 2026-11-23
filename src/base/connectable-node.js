import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be connected to is a RConnectableNode
 *
 * @class      RConnectableNode (name)
 */
export default class RConnectableNode extends RAudioNode {
  componentWillUnmount() {
    // disconnect every parent feeding this node before removing the registry
    // entry in super.componentWillUnmount()
    if (this.props.parent) {
      const registry = this.context.nodes;
      const parents = this.props.parent();

      this.flattenPointers(parents).forEach(parentPointer => {
        if (parentPointer === undefined || parentPointer === null) return;

        // the pointer is either a still-unregistered Symbol or a concrete node;
        // disconnectFrom tolerates both and never throws on missing connections
        if (typeof parentPointer === 'symbol') {
          registry.pending = registry.pending.filter(entry =>
            !(entry.toKey === parentPointer && entry.source === this.node));
          const parentNode = registry.get(parentPointer);
          if (parentNode) registry.disconnectFrom(parentNode, this.node);
        } else {
          registry.disconnectFrom(parentPointer, this.node);
        }
      });
    }

    super.componentWillUnmount();
  }
}
