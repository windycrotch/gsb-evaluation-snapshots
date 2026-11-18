/**
 * Processing-order planning for one audio block.
 *
 * Modules are processed once per block in an order derived from the cables,
 * not from the order the modules happen to appear in the graph:
 *
 * 1. The module graph is condensed into strongly connected components (SCCs).
 * 2. The resulting component DAG is topologically sorted, so every module
 *    runs after everything that feeds it through an acyclic path.
 * 3. Inside a cycle, the order is a reversed DFS post-order started from the
 *    members in declaration order. That is a topological order of every cable
 *    except the ones that actually close the cycle (the DFS back edges), so a
 *    simple ring keeps exactly one delayed cable, and the result stays
 *    deterministic for a given patch.
 *
 * A cycle cannot be evaluated in zero time. Each cable whose source runs at
 * or after its destination in that schedule (the DFS back edges, plus all
 * self-patches) is marked `delayed`: its consumer reads the source's output
 * from the previous block. A simple feedback loop therefore closes with about
 * one audio block of latency while every module still runs exactly once per
 * block.
 */

export interface ModuleEdge {
  from: string;
  to: string;
}

export interface ProcessingPlan {
  /** Every module id exactly once, in block processing order. */
  order: string[];
  /** Parallel to the edges passed in: true when the consumer reads last block's output. */
  delayed: boolean[];
}

interface Frame {
  id: string;
  next: number;
}

/**
 * Tarjan's SCC algorithm, iterative so that long cable chains cannot overflow
 * the call stack inside the audio thread.
 */
function findComponents(ids: readonly string[], adjacency: Map<string, string[]>): string[][] {
  const discovery = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  for (const start of ids) {
    if (discovery.has(start)) continue;

    const frames: Frame[] = [{ id: start, next: 0 }];
    discovery.set(start, nextIndex);
    lowLink.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const targets = adjacency.get(frame.id) ?? [];

      if (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;

        if (!discovery.has(target)) {
          discovery.set(target, nextIndex);
          lowLink.set(target, nextIndex);
          nextIndex += 1;
          stack.push(target);
          onStack.add(target);
          frames.push({ id: target, next: 0 });
        } else if (onStack.has(target)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id)!, discovery.get(target)!));
        }
        continue;
      }

      frames.pop();

      if (lowLink.get(frame.id) === discovery.get(frame.id)) {
        const members: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.id);
        components.push(members);
      }

      const parent = frames[frames.length - 1];
      if (parent) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id)!, lowLink.get(frame.id)!));
      }
    }
  }

  return components;
}

/**
 * Builds the block schedule for a module graph.
 *
 * `moduleIds` must be in a stable order (the graph's declaration order); it is
 * used both as the deterministic tie-break between independent modules and as
 * the in-cycle ordering.
 */
export function planProcessing(
  moduleIds: readonly string[],
  connections: readonly ModuleEdge[]
): ProcessingPlan {
  const declarationIndex = new Map<string, number>();
  for (let i = 0; i < moduleIds.length; i += 1) {
    declarationIndex.set(moduleIds[i], i);
  }

  // Deduplicate module-level edges: two cables between the same pair of
  // modules are one dependency for ordering purposes.
  const adjacency = new Map<string, string[]>();
  for (const id of moduleIds) adjacency.set(id, []);
  const seenEdges = new Set<string>();
  for (const { from, to } of connections) {
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    adjacency.get(from)!.push(to);
  }
  for (const targets of adjacency.values()) {
    targets.sort((a, b) => declarationIndex.get(a)! - declarationIndex.get(b)!);
  }

  // Condense cycles, then topologically order the component DAG. Independent
  // components are released in declaration order so scheduling is stable.
  const components = findComponents(moduleIds, adjacency);
  const componentOf = new Map<string, number>();
  components.forEach((members, component) => {
    for (const id of members) componentOf.set(id, component);
  });
  const componentAdjacency: Set<number>[] = components.map(() => new Set<number>());
  const componentInDegree = new Array<number>(components.length).fill(0);
  for (const [from, targets] of adjacency) {
    const fromComponent = componentOf.get(from)!;
    for (const to of targets) {
      const toComponent = componentOf.get(to)!;
      if (fromComponent === toComponent) continue;
      if (componentAdjacency[fromComponent].has(toComponent)) continue;
      componentAdjacency[fromComponent].add(toComponent);
      componentInDegree[toComponent] += 1;
    }
  }

  const componentKey = components.map((members) =>
    members.reduce((min, id) => Math.min(min, declarationIndex.get(id)!), Infinity)
  );
  const ready: number[] = [];
  for (let component = 0; component < components.length; component += 1) {
    if (componentInDegree[component] === 0) ready.push(component);
  }
  ready.sort((a, b) => componentKey[a] - componentKey[b]);

  const componentOrder: number[] = [];
  while (ready.length > 0) {
    const component = ready.shift()!;
    componentOrder.push(component);

    for (const next of componentAdjacency[component]) {
      componentInDegree[next] -= 1;
      if (componentInDegree[next] !== 0) continue;
      const insertAt = ready.findIndex((queued) => componentKey[queued] > componentKey[next]);
      if (insertAt === -1) ready.push(next);
      else ready.splice(insertAt, 0, next);
    }
  }

  // A condensation is a DAG, so every component is reachable from the ready
  // set; the fallback only guards against malformed input.
  if (componentOrder.length < components.length) {
    const ordered = new Set(componentOrder);
    const remaining = components
      .map((_, component) => component)
      .filter((component) => !ordered.has(component))
      .sort((a, b) => componentKey[a] - componentKey[b]);
    componentOrder.push(...remaining);
  }

  const order: string[] = [];
  for (const component of componentOrder) {
    order.push(...orderComponent(components[component], adjacency, declarationIndex));
  }

  const position = new Map<string, number>();
  order.forEach((id, index) => position.set(id, index));

  const delayed = connections.map(({ from, to }) => {
    const fromComponent = componentOf.get(from);
    const toComponent = componentOf.get(to);
    if (fromComponent === undefined || toComponent === undefined) return false;
    if (fromComponent !== toComponent) return false;
    // Back edge (or self-patch): the source has not produced this block's
    // output yet when the consumer gathers its inputs.
    return position.get(from)! >= position.get(to)!;
  });

  return { order, delayed };
}

/**
 * Orders the modules of one strongly connected component.
 *
 * A DFS post-order, reversed, is a topological order of everything except the
 * edges that actually close a cycle ("back edges" to a node still on the DFS
 * stack) — those are exactly the edges the caller will delay. For a simple
 * ring this leaves precisely one delayed cable, so the loop closes with one
 * block of latency regardless of how the modules happen to be declared. The
 * DFS starts from the members in declaration order, so the result is
 * deterministic.
 */
function orderComponent(
  members: readonly string[],
  adjacency: Map<string, string[]>,
  declarationIndex: Map<string, number>
): string[] {
  const memberSet = new Set(members);
  const roots = [...members].sort((a, b) => declarationIndex.get(a)! - declarationIndex.get(b)!);
  const state = new Map<string, 'visiting' | 'done'>();
  const postOrder: string[] = [];

  for (const root of roots) {
    if (state.has(root)) continue;

    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, 'visiting');

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = (adjacency.get(frame.id) ?? []).filter((target) => memberSet.has(target));

      if (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;
        if (!state.has(target)) {
          state.set(target, 'visiting');
          stack.push({ id: target, next: 0 });
        }
        continue;
      }

      stack.pop();
      state.set(frame.id, 'done');
      postOrder.push(frame.id);
    }
  }

  return postOrder.reverse();
}
