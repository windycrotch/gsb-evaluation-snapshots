import React from 'react';
import RBufferSource from '../src/audio-nodes/buffer-source.js';
import { createRAudioContext, mountRAudio } from './helpers.js';
import { MockAudioNode } from './web-audio-mock.js';

const buffer = { id: 'fake-audio-buffer' };

function bufferSource(props = {}, context = createRAudioContext()) {
  const identifier = props.identifier || Symbol('RBufferSource');

  const element = React.createElement(RBufferSource, Object.assign({
    buffer,
    start: 0,
    identifier
  }, props));

  return Object.assign({ identifier, element, context }, mountRAudio(element, context));
}

describe('RScheduledSource lifecycle', () => {
  test('rebuilds the underlying node and reconnects all destinations after playback ends', () => {
    const destinationA = new MockAudioNode();
    const destinationB = new MockAudioNode();

    const mounted = bufferSource({
      start: 0,
      destination: () => [destinationA, destinationB]
    });

    const firstNode = mounted.instance().node;

    expect(firstNode.startCalls).toHaveLength(1);
    expect(firstNode.connections.map(c => c.target))
      .toEqual(expect.arrayContaining([destinationA, destinationB]));

    // simulate Web Audio firing `ended` when the source finishes
    firstNode.dispatchEvent({ type: 'ended' });

    const secondNode = mounted.instance().node;

    // a brand-new underlying node must exist and be registered under the same key
    expect(secondNode).not.toBe(firstNode);
    expect(mounted.context.nodes.get(mounted.identifier)).toBe(secondNode);

    // the fresh node must be wired to every destination again
    expect(secondNode.connections.map(c => c.target))
      .toEqual(expect.arrayContaining([destinationA, destinationB]));

    // the finished node was detached before being replaced
    expect(firstNode.connections).toHaveLength(0);
    expect(secondNode.startCalls).toHaveLength(0);

    mounted.unmount();
  });

  test('asks upstream parents to disconnect while unmounting', () => {
    const context = createRAudioContext();
    const parent = new MockAudioNode();
    const parentIdentifier = Symbol('parent');
    context.nodes.set(parentIdentifier, parent);

    const mounted = bufferSource({
      parent: () => [parentIdentifier]
    }, context);

    const sourceNode = mounted.instance().node;
    parent.connect(sourceNode);

    expect(parent.connections.map(c => c.target)).toContain(sourceNode);

    mounted.unmount();

    expect(parent.connections.map(c => c.target)).not.toContain(sourceNode);
    expect(parent.disconnectCalls).toBeGreaterThan(0);
    // own node disconnected as well
    expect(sourceNode.connections).toHaveLength(0);
  });

  test('safely skips parents that no longer exist in the registry', () => {
    const staleParentIdentifier = Symbol('already-unmounted-parent');

    const mounted = bufferSource({
      parent: () => [staleParentIdentifier]
    });

    expect(() => mounted.unmount()).not.toThrow();
  });

  test('does not start when start is later than (or equal to) stop', () => {
    const laterStop = bufferSource({ start: 2, stop: 1 });

    expect(laterStop.instance().node.startCalls).toHaveLength(0);
    expect(laterStop.instance().node.stopCalls).toHaveLength(0);

    laterStop.rerender(React.createElement(RBufferSource, {
      buffer,
      identifier: laterStop.identifier,
      start: 1,
      stop: 1,
      destination: laterStop.instance().props.destination
    }));

    expect(laterStop.instance().node.startCalls).toHaveLength(0);
    expect(laterStop.instance().node.stopCalls).toHaveLength(0);

    laterStop.unmount();
  });

  test('never starts twice and never stops an unstarted node on repeated prop updates', () => {
    const mounted = bufferSource({ start: 0, stop: 10 });
    const node = mounted.instance().node;

    expect(node.startCalls).toHaveLength(1);
    expect(node.stopCalls).toHaveLength(1);

    const rerender = patch => mounted.rerender(React.createElement(RBufferSource, Object.assign(
      {},
      mounted.instance().props,
      patch
    )));

    rerender({ start: 0, stop: 10 });
    rerender({ start: 0.1, stop: 10 });
    rerender({ start: 0.1, stop: 11 });
    rerender({ stop: 12 });

    expect(node.startCalls).toHaveLength(1);
    expect(node.stopCalls).toHaveLength(1);

    // removing stop cannot make stop() fire on a fresh node without a start
    rerender({ stop: undefined });
    expect(node.stopCalls).toHaveLength(1);

    mounted.unmount();
  });

  test('schedules a stop only after a start has actually happened', () => {
    // no start prop at all: stop must not be attempted
    const mounted = bufferSource({ start: undefined, stop: 5 });

    const node = mounted.instance().node;
    expect(node.startCalls).toHaveLength(0);
    expect(node.stopCalls).toHaveLength(0);

    // now supply a valid start -> both start and the pending stop run
    mounted.rerender(React.createElement(RBufferSource, Object.assign(
      {},
      mounted.instance().props,
      { start: 1, stop: 5 }
    )));

    expect(node.startCalls).toHaveLength(1);
    expect(node.stopCalls).toHaveLength(1);
    expect(node.stopCalls[0]).toEqual({ when: 5 });

    mounted.unmount();
  });
});
