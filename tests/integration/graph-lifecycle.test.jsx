import React from 'react';
import {
  RAudioContext,
  RPipeline,
  RSplit,
  RGain,
  ROscillator,
  RBufferSource
} from '../../index.js';
import LateNode from '../helpers/late-node.jsx';
import { mountGraph, rerender, instancesOf, registryKeys, keyFor } from '../helpers/mount.js';

const gainNodes = (handle) => handle.audio.createdNodes.filter(n => n.nodeType === 'GainNode');

// stateful wrapper so re-renders keep the same component instances while
// letting tests mutate props (identifiers are re-generated on every render)
class Harness extends React.Component {
  render() {
    return this.props.children;
  }
}

describe('r-audio graph lifecycle', () => {
  describe('1. normal reconnection', () => {
    test('siblings in a pipeline connect in JSX order on mount', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} />
            <RGain gain={0.25} />
          </RPipeline>
        </RAudioContext>
      );

      const [ first, second ] = gainNodes(handle);
      expect(first.hasConnectionTo(second)).toBe(true);
      expect(second.hasConnectionTo(handle.audio.destination)).toBe(true);

      handle.unmount();
    });

    test('parent re-render re-connects without creating new node instances', () => {
      const handle = mountGraph(
        <Harness gainA={0.5}>
          <RAudioContext>
            <RPipeline>
              <RGain gain={0.5} />
              <RGain gain={0.25} />
            </RPipeline>
          </RAudioContext>
        </Harness>
      );

      const [ first, second ] = gainNodes(handle);
      const firstKeyBefore = keyFor(handle.registry, first);

      // force a full re-render: RPipeline generates fresh child identifiers
      rerender(handle,
        <Harness gainA={0.8}>
          <RAudioContext>
            <RPipeline>
              <RGain gain={0.8} />
              <RGain gain={0.25} />
            </RPipeline>
          </RAudioContext>
        </Harness>
      );

      // the same AudioNode instances survive (no re-creation), but their key
      // has been atomically moved to the newly generated identifier
      expect(handle.registry.get(firstKeyBefore)).toBeUndefined();
      const firstKeyAfter = keyFor(handle.registry, first);
      expect(firstKeyAfter).not.toBe(firstKeyBefore);
      expect(handle.registry.get(firstKeyAfter)).toBe(first);
      // every node has exactly one key and nothing stale lingers
      expect(handle.registry.size).toBe(2);
      // the graph is still wired in JSX order
      expect(first.hasConnectionTo(second)).toBe(true);
      expect(second.hasConnectionTo(handle.audio.destination)).toBe(true);

      handle.unmount();
    });

    test('parallel RSplit branches all connect to the destination', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RSplit>
            <RGain gain={0.1} />
            <RGain gain={0.2} />
            <RGain gain={0.3} />
          </RSplit>
        </RAudioContext>
      );

      const gains = gainNodes(handle);
      expect(gains).toHaveLength(3);
      gains.forEach(node => {
        expect(node.hasConnectionTo(handle.audio.destination)).toBe(true);
      });

      handle.unmount();
    });
  });

  describe('2. missing target with backfill', () => {
    test('a connection to a target that registers later is not lost', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <LateNode />
            <LateNode />
          </RPipeline>
        </RAudioContext>
      );

      const [ early, late ] = gainNodes(handle);

      // neither node has published itself yet. The upstream's outbound
      // connection is recorded as pending instead of touching an undefined
      // target
      expect(early.hasConnectionTo(late)).toBe(false);
      expect(handle.registry.pending).toHaveLength(1);

      // the target registers: the pending connection is backfilled immediately
      const lateInstance = instancesOf(handle.root, LateNode)[1];
      lateInstance.release();

      expect(early.hasConnectionTo(late)).toBe(true);
      expect(handle.registry.pending).toHaveLength(0);

      // the upstream registers afterwards; its re-asserted connection is a
      // harmless no-op rather than a duplicate
      const earlyInstance = instancesOf(handle.root, LateNode)[0];
      const connectionsBefore = early.connections.filter(n => n === late).length;
      earlyInstance.release();
      const connectionsAfter = early.connections.filter(n => n === late).length;
      expect(connectionsAfter).toBe(connectionsBefore);

      handle.unmount();
    });

    test('an already-registered upstream still reaches a target that appears late', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} />
            <LateNode />
          </RPipeline>
        </RAudioContext>
      );

      const [ upstream, late ] = gainNodes(handle);

      // the normal RGain registered before the LateNode published itself, so
      // its outbound connection had to be deferred
      expect(upstream.hasConnectionTo(late)).toBe(false);
      expect(handle.registry.pending.length).toBeGreaterThan(0);

      instancesOf(handle.root, LateNode)[0].release();

      expect(upstream.hasConnectionTo(late)).toBe(true);
      expect(handle.registry.pending).toHaveLength(0);

      handle.unmount();
    });
  });

  describe('3. unmount and repeated unmount', () => {
    test('unmounting a child removes its key and its parent’s connection to it', () => {
      const Conditional = ({ showSecond }) => (
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} />
            {showSecond ? <RGain gain={0.25} /> : null}
          </RPipeline>
        </RAudioContext>
      );

      const handle = mountGraph(<Conditional showSecond={true} />);
      const [ first, second ] = gainNodes(handle);
      const secondKey = keyFor(handle.registry, second);

      expect(first.hasConnectionTo(second)).toBe(true);

      rerender(handle, <Conditional showSecond={false} />);

      expect(handle.registry.has(secondKey)).toBe(false);
      expect(first.hasConnectionTo(second)).toBe(false);
      // the surviving node falls through to the pipeline destination
      expect(first.hasConnectionTo(handle.audio.destination)).toBe(true);
    });

    test('unmounting the whole graph is idempotent and leaves an empty registry', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} />
            <RGain gain={0.25} />
          </RPipeline>
        </RAudioContext>
      );

      expect(handle.registry.size).toBe(2);

      expect(() => handle.unmount()).not.toThrow();
      expect(() => handle.unmount()).not.toThrow();

      expect(handle.registry.size).toBe(0);
      expect(registryKeys(handle.registry)).toHaveLength(0);
    });

    test('repeated cleanup never throws even when disconnect would reject', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} />
            <RGain gain={0.25} />
          </RPipeline>
        </RAudioContext>
      );

      const [ first, second ] = gainNodes(handle);
      // simulate a browser that throws on disconnecting an unknown connection
      first.disconnect = () => { throw new Error('InvalidAccessError'); };

      expect(() => {
        handle.registry.disconnectFrom(first, second);
        handle.registry.disconnectFrom(first, second);
        handle.unmount();
      }).not.toThrow();
    });
  });

  describe('4. rapid identifier changes', () => {
    test('many quick identifier changes leave only the newest key', () => {
      const Controlled = ({ tag }) => (
        <RAudioContext>
          <RPipeline>
            <RGain gain={0.5} name={tag} />
            <RGain gain={0.25} />
          </RPipeline>
        </RAudioContext>
      );

      const handle = mountGraph(<Controlled tag="a" />);
      const [ first ] = gainNodes(handle);
      const originalKey = keyFor(handle.registry, first);

      // each RPipeline re-render mints a brand-new Symbol for the first child
      for (let i = 0; i < 5; i++) {
        rerender(handle, <Controlled tag={`tag-${i}`} />);
      }

      const currentKey = keyFor(handle.registry, first);
      expect(currentKey).not.toBe(originalKey);
      // exactly one entry points at the gain node — no stale identifiers
      const entriesForFirst = registryKeys(handle.registry)
        .filter(key => handle.registry.get(key) === first);
      expect(entriesForFirst).toHaveLength(1);
      // total registry size stays bounded: two gains, nothing else
      expect(handle.registry.size).toBe(2);

      // unmount after identifier churn cleans up the current key without errors
      expect(() => handle.unmount()).not.toThrow();
      expect(handle.registry.size).toBe(0);
    });
  });

  describe('source nodes rebuilt after playback ended', () => {
    test('an Oscillator rebuild refreshes registry and downstream connections', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <ROscillator frequency={440} start={0} />
            <RGain gain={0.5} />
          </RPipeline>
        </RAudioContext>
      );

      const oscillators = () =>
        handle.audio.createdNodes.filter(n => n.nodeType === 'OscillatorNode');
      const [ gain ] = gainNodes(handle);

      const first = oscillators()[0];
      const firstKey = keyFor(handle.registry, first);
      expect(first.hasConnectionTo(gain)).toBe(true);

      // the oscillator reaches its scheduled stop: fire the ended event
      first.dispatchEvent({ type: 'ended' });

      const rebuilt = oscillators()[1];
      expect(rebuilt).not.toBe(first);

      // same identifier now points at the fresh instance
      expect(handle.registry.get(firstKey)).toBe(rebuilt);
      // the fresh instance is wired to the same downstream gain node
      expect(rebuilt.hasConnectionTo(gain)).toBe(true);
      // no extra registry entries were created
      expect(handle.registry.size).toBe(2);

      handle.unmount();
    });

    test('a BufferSource rebuild replaces the stopped node instead of keeping it', () => {
      const buffer = new AudioBuffer({ numberOfChannels: 1, length: 64, sampleRate: 44100 });

      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <RBufferSource buffer={buffer} start={0} />
            <RGain gain={0.5} />
          </RPipeline>
        </RAudioContext>
      );

      const sources = () =>
        handle.audio.createdNodes.filter(n => n.nodeType === 'AudioBufferSourceNode');
      const [ gain ] = gainNodes(handle);

      const first = sources()[0];
      const key = keyFor(handle.registry, first);
      expect(first.hasConnectionTo(gain)).toBe(true);

      first.dispatchEvent({ type: 'ended' });

      const rebuilt = sources()[1];
      expect(rebuilt).not.toBe(first);
      expect(handle.registry.get(key)).toBe(rebuilt);
      expect(rebuilt.hasConnectionTo(gain)).toBe(true);
      // the stopped node no longer appears anywhere in the registry
      expect(registryKeys(handle.registry).some(k => handle.registry.get(k) === first)).toBe(false);

      handle.unmount();
    });

    test('an ended event after unmount does not resurrect a registry entry', () => {
      const handle = mountGraph(
        <RAudioContext>
          <RPipeline>
            <ROscillator frequency={440} start={0} />
            <RGain gain={0.5} />
          </RPipeline>
        </RAudioContext>
      );

      const oscillator = handle.audio.createdNodes.find(n => n.nodeType === 'OscillatorNode');
      handle.unmount();
      expect(handle.registry.size).toBe(0);

      // late `ended` delivery must not re-register anything
      expect(() => oscillator.dispatchEvent({ type: 'ended' })).not.toThrow();
      expect(handle.registry.size).toBe(0);
    });
  });
});
