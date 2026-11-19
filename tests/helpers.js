import React from 'react';
import PropTypes from 'prop-types';
import TestRenderer from 'react-test-renderer';
import { MockAudioContext } from './web-audio-mock.js';

/**
 * Builds the legacy React 16 context object that RAudioNode components
 * consume (the same shape RAudioContext.getChildContext produces).
 */
export function createRAudioContext() {
  const audio = new MockAudioContext();
  const nodes = new Map();

  return {
    audio,
    nodes,
    debug: false
  };
}

/**
 * Minimal stand-in for RAudioContext: pushes the mock audio context and
 * node registry down through React 16 legacy context.
 */
class RAudioContextProvider extends React.Component {
  getChildContext() {
    return this.props.context;
  }

  render() {
    return React.Children.only(this.props.children);
  }
}

RAudioContextProvider.childContextTypes = {
  audio: PropTypes.object,
  nodes: PropTypes.object,
  debug: PropTypes.bool
};

/**
 * Mounts a r-audio component with a mock RAudioContext, returning the
 * mounted component instance plus render helpers.
 */
export function mountRAudio(element, context) {
  const type = element.type;

  const wrap = child =>
    React.createElement(RAudioContextProvider, { context }, child);

  const renderer = TestRenderer.create(wrap(element));

  return {
    renderer,
    instance: () => renderer.root.findByType(type).instance,

    rerender(nextElement) {
      renderer.update(wrap(nextElement));
    },

    unmount() {
      renderer.unmount();
    }
  };
}
