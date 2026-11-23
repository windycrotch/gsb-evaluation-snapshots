import React from 'react';
import RAudioNode from './../base/audio-node.js';
import RComponent from './../base/component.js';

import { isConnectable } from './utils.js';

/**
 * A RComponent which connects each child to itself as well as the destination
 *
 * @class      RCycle (name)
 */
export default class RCycle extends RComponent {
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
    this.context.nodes.unregister(this.props.identifier, this.inputs);
  }

  render() {
    while (this.inputs.length > 0) this.inputs.pop();

    const children = React.Children
      .toArray(this.props.children)
      .filter(c => c !== null && c !== [])
      .map(c => ({ component: c, identifier: Symbol(c.type.name + Date.now()) }))
      .map((childTuple, childIndex, childrenArray) => {
        const type = childTuple.component.type;
        if (RComponent.isPrototypeOf(childTuple.component.type) && isConnectable(childTuple.component)) {
          this.inputs.push(childTuple.identifier);
        }

        const pipelineProps = {
          destination: () => {
            let destination = this.props.destination();

            const ownNode = this.context.nodes.get(childTuple.identifier);
            if (!(destination instanceof Array)) destination = [ destination ];

            return destination.concat([ ownNode ]);
          },
          identifier: childTuple.identifier
        };

        return React.cloneElement(childTuple.component, pipelineProps);
      });

    if (this.inputs.length === 0) {
      const destination = this.props.destination();
      if (destination instanceof Array) this.inputs.push(...destination);
      else this.inputs.push(destination);
    }

    if (this.context.debug) {
      return (
        <li>
          <strong>RCycle</strong>
          <ul>
            {children}
          </ul>
        </li>
      );
    }

    return children;
  }
}
