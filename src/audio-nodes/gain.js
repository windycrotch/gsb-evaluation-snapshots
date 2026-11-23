import React from 'react';
import RConnectableNode from './../base/connectable-node.js';

export default class RGain extends RConnectableNode {
  constructor(props) {
    super(props);

    this.params = {
      gain: this.props.gain
    };
  }

  componentWillMount() {
    super.componentWillMount();

    if (!this.node) {
      this.node = this.context.audio.createGain();
      this.registerNode();
    }

    this.updateParams = this.updateParams.bind(this);
    this.updateParams(this.props);
  }
}
