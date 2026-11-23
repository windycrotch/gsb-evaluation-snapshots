import AudioNodeRegistry from '../../src/base/node-registry.js';

const makeNode = (name) => ({
  name,
  connect: jest.fn(),
  disconnect: jest.fn()
});

describe('AudioNodeRegistry', () => {
  let registry;
  let source;
  let target;

  beforeEach(() => {
    registry = new AudioNodeRegistry();
    source = makeNode('source');
    target = makeNode('target');
  });

  describe('Map semantics', () => {
    test('is a Map so legacy get/has/forEach call sites keep working', () => {
      const key = Symbol('k');
      registry.set(key, target);
      expect(registry).toBeInstanceOf(Map);
      expect(registry.get(key)).toBe(target);
      expect(registry.has(key)).toBe(true);
    });
  });

  describe('normal reconnection', () => {
    test('connects immediately when the target is registered', () => {
      const targetKey = Symbol('target');
      const fromKey = Symbol('source');
      registry.register(targetKey, target);

      const connected = registry.requestConnect(source, targetKey, [0, 0], fromKey);

      expect(connected).toBe(true);
      expect(source.connect).toHaveBeenCalledWith(target, 0, 0);
      expect(registry.inbound.get(targetKey)).toHaveLength(1);
    });

    test('connectToNode resolves a concrete node via its registry key', () => {
      const targetKey = Symbol('target');
      registry.register(targetKey, target);

      registry.connectToNode(source, target, [], Symbol('source'));

      expect(source.connect).toHaveBeenCalledWith(target);
      expect(registry.inbound.get(targetKey)).toHaveLength(1);
    });

    test('concrete nodes without a key (e.g. AudioContext.destination) connect directly', () => {
      const destination = makeNode('destination');
      registry.connectToNode(source, destination, [], Symbol('source'));

      expect(source.connect).toHaveBeenCalledWith(destination);
    });

    test('re-registering the same key with the same node is a no-op for connections', () => {
      const targetKey = Symbol('target');
      registry.register(targetKey, target);
      registry.requestConnect(source, targetKey, [], Symbol('source'));

      registry.register(targetKey, target);

      expect(source.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('missing target with backfill', () => {
    test('skips a missing target instead of connecting to undefined, then backfills', () => {
      const targetKey = Symbol('late-target');
      const fromKey = Symbol('source');

      const connected = registry.requestConnect(source, targetKey, [0, 0], fromKey);

      expect(connected).toBe(false);
      expect(source.connect).not.toHaveBeenCalled();
      expect(registry.pending).toHaveLength(1);

      // target finally registers — the pending connection must be fulfilled
      registry.register(targetKey, target);

      expect(source.connect).toHaveBeenCalledWith(target, 0, 0);
      expect(registry.pending).toHaveLength(0);
    });

    test('de-duplicates repeated pending requests for the same source/target', () => {
      const targetKey = Symbol('late-target');
      const fromKey = Symbol('source');
      registry.requestConnect(source, targetKey, [], fromKey);
      registry.requestConnect(source, targetKey, [], fromKey);

      expect(registry.pending).toHaveLength(1);
    });

    test('an earlier registrant never permanently loses a connection to a later registrant', () => {
      // same render pass: node A registers and wants to reach node B,
      // node B only registers afterwards
      const keyA = Symbol('A');
      const keyB = Symbol('B');
      const nodeA = makeNode('A');
      const nodeB = makeNode('B');

      registry.register(keyA, nodeA);
      registry.requestConnect(nodeA, keyB, [], keyA);

      expect(registry.pending).toHaveLength(1);

      registry.register(keyB, nodeB);

      expect(nodeA.connect).toHaveBeenCalledWith(nodeB);
      expect(registry.pending).toHaveLength(0);
    });
  });

  describe('unmount and repeated unmount', () => {
    test('unregister removes the key and disconnects every inbound parent', () => {
      const targetKey = Symbol('target');
      const parentA = makeNode('parentA');
      const parentB = makeNode('parentB');

      registry.register(targetKey, target);
      registry.requestConnect(parentA, targetKey, [], Symbol('a'));
      registry.requestConnect(parentB, targetKey, [], Symbol('b'));

      registry.unregister(targetKey, target);

      expect(registry.has(targetKey)).toBe(false);
      expect(parentA.disconnect).toHaveBeenCalledWith(target);
      expect(parentB.disconnect).toHaveBeenCalledWith(target);
      expect(registry.inbound.has(targetKey)).toBe(false);
    });

    test('repeated unregister never throws and leaves the registry empty', () => {
      const targetKey = Symbol('target');
      registry.register(targetKey, target);
      registry.unregister(targetKey, target);

      expect(() => registry.unregister(targetKey, target)).not.toThrow();
      expect(() => registry.unregister(targetKey, target)).not.toThrow();
      expect(registry.has(targetKey)).toBe(false);
    });

    test('unregister discards pending requests pointing at the removed key', () => {
      const targetKey = Symbol('never-registered');
      registry.requestConnect(source, targetKey, [], Symbol('source'));

      registry.unregister(targetKey);

      expect(registry.pending).toHaveLength(0);
    });

    test('a stale instance cannot clobber a newer one registered under the same key', () => {
      const key = Symbol('source');
      const first = makeNode('first');
      const second = makeNode('second');

      registry.register(key, first);
      registry.register(key, second); // source rebuilt after `ended`

      registry.unregister(key, first); // late cleanup of the dead instance

      expect(registry.get(key)).toBe(second);
    });

    test('safeDisconnect swallows errors from already-gone connections', () => {
      const grumpy = makeNode('grumpy');
      grumpy.disconnect = jest.fn(() => { throw new Error('InvalidAccessError'); });

      expect(() => registry.safeDisconnect(grumpy, target)).not.toThrow();
    });
  });

  describe('rapid identifier changes', () => {
    test('replaceKey always removes the old key and keeps only the newest one', () => {
      const key1 = Symbol('k1');
      const key2 = Symbol('k2');
      const key3 = Symbol('k3');

      registry.register(key1, target);
      registry.replaceKey(key1, key2, target);
      registry.replaceKey(key2, key3, target);

      expect(registry.has(key1)).toBe(false);
      expect(registry.has(key2)).toBe(false);
      expect(registry.get(key3)).toBe(target);
    });

    test('rapid back-to-back changes leave exactly one registry entry', () => {
      const initial = Symbol('initial');
      registry.register(initial, target);

      let current = initial;
      for (let i = 0; i < 5; i++) {
        const next = Symbol(`k${i}`);
        registry.replaceKey(current, next, target);
        current = next;
      }

      expect(registry.size).toBe(1);
      expect(registry.get(current)).toBe(target);
    });

    test('inbound connection bookkeeping follows the key replacement', () => {
      const oldKey = Symbol('old');
      const newKey = Symbol('new');
      registry.register(oldKey, target);
      registry.requestConnect(source, oldKey, [], Symbol('source'));

      registry.replaceKey(oldKey, newKey, target);

      expect(registry.inbound.has(oldKey)).toBe(false);
      expect(registry.inbound.get(newKey)).toHaveLength(1);
    });

    test('a pending connection is re-pointed when its target changes identifier', () => {
      const oldKey = Symbol('old');
      const newKey = Symbol('new');
      registry.requestConnect(source, oldKey, [], Symbol('source'));

      registry.replaceKey(oldKey, newKey);
      registry.register(newKey, target);

      expect(source.connect).toHaveBeenCalledWith(target);
      expect(registry.pending).toHaveLength(0);
    });
  });

  describe('source node rebuilt after playback ended', () => {
    test('replays all inbound connections onto the fresh instance', () => {
      const sourceKey = Symbol('source');
      const stopped = makeNode('stopped');
      const rebuilt = makeNode('rebuilt');
      const parent = makeNode('parent');

      registry.register(sourceKey, stopped);
      registry.requestConnect(parent, sourceKey, [0, 0], Symbol('parent'));

      registry.register(sourceKey, rebuilt);

      // upstream disconnected from the dead node and connected to the new one
      expect(parent.disconnect).toHaveBeenCalledWith(stopped);
      expect(parent.connect).toHaveBeenCalledWith(rebuilt, 0, 0);
      expect(registry.get(sourceKey)).toBe(rebuilt);
    });

    test('re-points the rebuilt node’s own pending outbound connections', () => {
      const sourceKey = Symbol('source');
      const downstreamKey = Symbol('downstream');
      const stopped = makeNode('stopped');
      const rebuilt = makeNode('rebuilt');
      const downstream = makeNode('downstream');

      registry.register(sourceKey, stopped);
      // downstream not registered yet while the source is alive
      registry.requestConnect(stopped, downstreamKey, [], sourceKey);
      // source ends and is rebuilt; downstream appears afterwards
      registry.register(sourceKey, rebuilt);
      registry.register(downstreamKey, downstream);

      expect(rebuilt.connect).toHaveBeenCalledWith(downstream);
      expect(stopped.connect).not.toHaveBeenCalled();
    });

    test('graph container arrays are stored without node-level connection logic', () => {
      const key = Symbol('split');
      const pointers = [Symbol('a'), Symbol('b')];

      expect(() => registry.register(key, pointers)).not.toThrow();
      expect(registry.get(key)).toBe(pointers);
    });
  });

  describe('dropSource', () => {
    test('removes every record of a node that disconnects itself', () => {
      const targetKey = Symbol('target');
      registry.register(targetKey, target);
      registry.requestConnect(source, targetKey, [], Symbol('source'));

      registry.dropSource(source);

      expect(registry.inbound.get(targetKey)).toEqual([]);
    });
  });
});
