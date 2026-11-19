import React from 'react';
import RGain from '../src/audio-nodes/gain.js';
import RBufferSource from '../src/audio-nodes/buffer-source.js';
import { createRAudioContext, mountRAudio } from './helpers.js';
import { MockAudioNode } from './web-audio-mock.js';

const buffer = { id: 'fake-audio-buffer' };

function gain(props = {}, context = createRAudioContext()) {
  const identifier = props.identifier || Symbol('RGain');

  const element = React.createElement(RGain, Object.assign({
    gain: 0.5,
    identifier
  }, props));

  return Object.assign({ identifier, element, context }, mountRAudio(element, context));
}

describe('RAudioNode destination and registry handling', () => {
  test('cleans up the old connection when the destination changes', () => {
    const firstDestination = new MockAudioNode();
    const secondDestination = new MockAudioNode();

    const mounted = gain({
      destination: () => firstDestination
    });

    const node = mounted.instance().node;
    expect(node.connections.map(c => c.target)).toEqual([firstDestination]);
    const disconnectsBeforeSwitch = node.disconnectCalls;

    mounted.rerender(React.createElement(RGain, Object.assign(
      {},
      mounted.instance().props,
      { destination: () => secondDestination }
    )));

    // old wiring removed before connecting the new destination
    expect(node.disconnectCalls).toBeGreaterThan(disconnectsBeforeSwitch);
    expect(node.connections.map(c => c.target)).toEqual([secondDestination]);
    expect(node.connections.map(c => c.target)).not.toContain(firstDestination);

    mounted.unmount();
  });

  test('re-applies connectToParam and channel arguments on (re)connection', () => {
    const destination = new MockAudioNode();
    // an AudioParam the source connects to instead of the node itself
    destination.frequency = { name: 'frequency' };

    const context = createRAudioContext();
    const identifier = Symbol('RBufferSource');

    const element = React.createElement(RBufferSource, {
      buffer,
      start: 0,
      identifier,
      destination: () => destination,
      connectToParam: 'frequency'
    });

    const mounted = mountRAudio(element, context);
    const node = mounted.instance().node;

    expect(node.connections).toHaveLength(1);
    expect(node.connections[0].target).toBe(destination.frequency);

    // switch back to a plain node connection with explicit channels
    mounted.rerender(React.createElement(RBufferSource, {
      buffer,
      start: 0,
      identifier,
      destination: () => destination,
      connectToParam: undefined,
      connectFromChannel: 1,
      connectToChannel: 2
    }));

    expect(node.connections).toHaveLength(1);
    expect(node.connections[0].target).toBe(destination);
    expect(node.connections[0].output).toBe(1);
    expect(node.connections[0].input).toBe(2);

    mounted.unmount();
  });

  test('moves the registry entry when the identifier changes and leaves no stale key', () => {
    const firstIdentifier = Symbol('first-identifier');
    const secondIdentifier = Symbol('second-identifier');
    const context = createRAudioContext();

    const mounted = gain({ identifier: firstIdentifier }, context);
    const node = mounted.instance().node;

    expect(context.nodes.get(firstIdentifier)).toBe(node);

    mounted.rerender(React.createElement(RGain, Object.assign(
      {},
      mounted.instance().props,
      { identifier: secondIdentifier }
    )));

    expect(context.nodes.has(firstIdentifier)).toBe(false);
    expect(context.nodes.get(secondIdentifier)).toBe(node);
    expect(context.nodes.size).toBe(1);

    mounted.unmount();

    expect(context.nodes.has(secondIdentifier)).toBe(false);
    expect(context.nodes.size).toBe(0);
  });

  test('leaves an empty registry after unmount', () => {
    const context = createRAudioContext();
    const mounted = gain({}, context);

    expect(context.nodes.size).toBe(1);

    mounted.unmount();

    expect(context.nodes.size).toBe(0);
  });

  test('keeps the linear-ramp fallback when a transition curve fails', () => {
    const mounted = gain({
      gain: 1,
      transitionTime: 2,
      transitionCurve: 'exponential'
    });

    const gainParam = mounted.instance().node.gain;

    // exponential ramps reject non-positive target values (see mock)
    expect(() => {
      mounted.rerender(React.createElement(RGain, {
        identifier: mounted.identifier,
        gain: 0,
        transitionTime: 3,
        transitionCurve: 'exponential'
      }));
    }).not.toThrow();

    const eventTypes = gainParam.automationEvents.map(e => e.type);
    expect(eventTypes).toContain('linearRampToValueAtTime');
    expect(gainParam.value).toBe(0);

    mounted.unmount();
  });
});
