import React from 'react';
import RConnectableNode from './../base/connectable-node.js';

export default class RChannelMerger extends RConnectableNode {
  constructor(props) {
    super(props);

    this.params = { channelCount: 1 };
  }

  componentWillMount() {
    super.componentWillMount();

    if (!this.node) {
      this.node = this.context.audio.createChannelMerger(this.props.channelCount);
      this.registerNode();
    }

    this.updateParams = this.updateParams.bind(this);
    this.updateParams(this.props);
  }
}
