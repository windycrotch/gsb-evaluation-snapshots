import RConnectableNode from '../../src/base/connectable-node.js';

/**
 * A gain-like node whose registry entry is published only when `release()` is
 * called. Earlier siblings therefore attempt their outbound connection while
 * the target is still missing, which lets tests prove the registry backfills
 * pending connections once the target registers.
 */
export default class LateNode extends RConnectableNode {
  componentWillMount() {
    // deliberately do NOT register here, unlike a normal RAudioNode
    this.node = this.context.audio.createGain();
  }

  componentDidMount() {
    // the node is still unregistered: any outbound connection requested here
    // must be recorded as pending rather than touching an undefined target
    this.connectToAllDestinations(this.props.destination, this.node);
  }

  release() {
    // publish the node; the registry fulfils every pending connection to it
    this.registerNode();
  }
}
