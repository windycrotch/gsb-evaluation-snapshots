import React from 'react';
import RAudioNode from './../base/audio-node.js';
import RComponent from './../base/component.js';

import {
  isConnectable,
  propertyFromChildOrParent
} from './utils.js';

/**
 * A RComponent which connects its children in parallel, creating inbound branches if necessary.
 *
 * @class      RSplit (name)
 */
export default class RSplit extends RComponent {
  constructor(props) {
    super(props);
    this.inputs = [];
  }

  componentWillMount() {
    super.componentWillMount();
    this.context.nodes.register(this.props.identifier, this.inputs);
  }

  componentWillUpdate(nextProps, nextState) {
    // move the registry record to the new identifier; the old key is always
    // removed so rapid identifier changes leave only the newest one
    if (this.props.identifier !== nextProps.identifier) {
      this.context.nodes.replaceKey(this.props.identifier, nextProps.identifier, this.inputs);
    }
  }

  componentWillUnmount() {
    // idempotent: a repeated unmount simply finds the key already gone
    this.context.nodes.unregister(this.props.identifier, this.inputs);
  }

  render() {
    while (this.inputs.length) this.inputs.pop();

    const children = React.Children
      .toArray(this.props.children)
      .filter(c => c !== null && c !== [])
      .map(c => ({ component: c, identifier: Symbol(c.type.name + Date.now()) }))
      .map((childTuple, childIndex, childrenArray) => {
        if (!RComponent.isPrototypeOf(childTuple.component.type)) return childTuple.component;

        const type = childTuple.component.type;
        if (RComponent.isPrototypeOf(type) && isConnectable(childTuple.component)) {
          this.inputs.push(childTuple.identifier);
        }

        // this rather strange and terse piece of code
        // figures out the channel connections of the RSplit child
        // where children can override the parent (RSplit) settings
        // this is useful for RSplitChannels
        const [ connectFromChannel, connectToChannel ] =
          [ 'connectFromChannel', 'connectToChannel' ]
            .map(propertyFromChildOrParent(childTuple.component, this));

        const splitProps = {
          destination: this.props.destination,
          identifier: childTuple.identifier,
          connectFromChannel,
          connectToChannel
        };

        return React.cloneElement(childTuple.component, splitProps);
      });

    if (!this.inputs.length) {
      const destination = this.props.destination();
      if (destination instanceof Array) this.inputs.push(...destination);
      else this.inputs.push(destination);
    }

    if (this.context.debug) {
      return (
        <li>
          <strong>RSplit</strong>
          <ul>
            {children}
          </ul>
        </li>
      );
    }

    return children;
  }
}
