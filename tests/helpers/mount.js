import React from 'react';
import TestRenderer from 'react-test-renderer';
import RAudioContext from '../../src/base/audio-context.js';

/**
 * Mounts an r-audio graph and returns handles to the renderer, the mock
 * AudioContext and the AudioNodeRegistry.
 */
export function mountGraph(element) {
  const renderer = TestRenderer.create(element);
  const root = renderer.root;
  const contextComponent = root.findByType(RAudioContext).instance;

  return {
    renderer,
    root,
    audio: contextComponent._context,
    registry: contextComponent.nodes,
    unmount: () => renderer.unmount()
  };
}

export function rerender(handle, element) {
  handle.renderer.update(element);
}

export function instancesOf(root, type) {
  return root.findAllByType(type).map(element => element.instance);
}

export function registryKeys(registry) {
  return Array.from(registry.keys());
}

export function keyFor(registry, node) {
  let found = null;
  registry.forEach((value, key) => {
    if (value === node) found = key;
  });
  return found;
}
