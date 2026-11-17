/**
 * Keeps track of the connections which r-audio makes between Web Audio nodes.
 *
 * The Web Audio API only exposes the outgoing connections of an AudioNode, so
 * in order to remove a single parent -> child connection (without touching
 * any of the sibling connections made by the same parent) the library needs
 * to keep its own record of the edges in the graph.
 *
 * All the maps are keyed by Web Audio objects (AudioNodes and AudioParams),
 * which makes them safe to keep around for the lifetime of the page.
 */

// source AudioNode -> array of { target, owner, args } records
const outgoingConnections = new WeakMap();
// owner AudioNode -> Set of source AudioNodes connected to it (or to one of its AudioParams)
const incomingConnections = new WeakMap();

const addIncoming = (owner, source) => {
  if (!owner || !source) return;

  let sources = incomingConnections.get(owner);

  if (!sources) {
    sources = new Set();
    incomingConnections.set(owner, sources);
  }

  sources.add(source);
};

const dropIncoming = (owner, source) => {
  if (!owner || !source) return;

  const sources = incomingConnections.get(owner);

  if (!sources) return;

  // the source might still be connected to another AudioParam of the same
  // owner, in which case its incoming record has to be kept
  const connections = outgoingConnections.get(source) || [];
  const stillConnected = connections.some(connection => connection.owner === owner);

  if (!stillConnected) sources.delete(source);

  if (!sources.size) incomingConnections.delete(owner);
};

/**
 * Records a connection made from `source` to `target`.
 *
 * @param      {AudioNode}  source   The AudioNode which was connected
 * @param      {AudioNode|AudioParam}  target  The object which was connected to
 * @param      {AudioNode}  owner    The AudioNode which owns `target` (the same node unless `target` is an AudioParam)
 * @param      {Array}  args  Extra arguments passed to AudioNode.connect
 */
const trackConnection = (source, target, owner, args = []) => {
  if (!source || !target) return;

  let connections = outgoingConnections.get(source);

  if (!connections) {
    connections = [];
    outgoingConnections.set(source, connections);
  }

  const connectionOwner = owner || target;

  connections.push({ target, owner: connectionOwner, args: Array.from(args) });

  addIncoming(connectionOwner, source);
};

/**
 * Returns the recorded outgoing connections of the given AudioNode.
 */
const getConnections = source => {
  const connections = outgoingConnections.get(source);

  return connections ? connections.slice() : [];
};

/**
 * Returns every edge which currently points at `owner` or at any of its
 * AudioParams, as an array of `{ source, target, args }` records.
 */
const getIncomingConnections = owner => {
  const sources = incomingConnections.get(owner);

  if (!sources) return [];

  const edges = [];

  sources.forEach(source => {
    getConnections(source)
      .filter(connection => connection.owner === owner)
      .forEach(connection => {
        edges.push({
          source,
          target: connection.target,
          args: connection.args
        });
      });
  });

  return edges;
};

/**
 * Removes the record of the connections between `source` and `target`.
 * Returns the removed connection records.
 */
const removeConnection = (source, target) => {
  if (!source || !target) return [];

  const connections = outgoingConnections.get(source);
  let removed = [];

  if (connections) {
    removed = connections.filter(connection => connection.target === target);

    const remaining = connections.filter(connection => connection.target !== target);

    if (remaining.length) outgoingConnections.set(source, remaining);
    else outgoingConnections.delete(source);
  }

  removed.forEach(connection => dropIncoming(connection.owner, source));

  return removed;
};

/**
 * Removes the record of all outgoing connections of the given AudioNode.
 * Returns the removed connection records.
 */
const clearConnections = source => {
  if (!source) return [];

  const connections = outgoingConnections.get(source) || [];

  outgoingConnections.delete(source);

  connections.forEach(connection => dropIncoming(connection.owner, source));

  return connections;
};

export {
  trackConnection,
  getConnections,
  getIncomingConnections,
  removeConnection,
  clearConnections
};
