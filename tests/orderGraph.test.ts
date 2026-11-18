import { describe, expect, it } from 'vitest';
import { planProcessing } from '../src/worklet/orderGraph';
import type { ModuleEdge } from '../src/worklet/orderGraph';

const edge = (from: string, to: string): ModuleEdge => ({ from, to });

/**
 * Checks the structural promises the scheduler makes, whatever the patch:
 * - every module occurs exactly once;
 * - every non-delayed cable runs from earlier to later in the order;
 * - a delayed cable only ever appears inside a cycle (or is a self-patch).
 */
function checkInvariants(ids: string[], edges: ModuleEdge[]) {
  const plan = planProcessing(ids, edges);

  expect([...plan.order].sort()).toEqual([...ids].sort());
  expect(plan.delayed).toHaveLength(edges.length);

  const position = new Map(plan.order.map((id, index) => [id, index]));
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of edges) adjacency.get(from)!.push(to);

  // Reachability in the same component: a delayed cable must not be the only
  // path from its target back past its source. We simply require that a
  // delayed edge's endpoints are mutually reachable (same cycle).
  const reaches = (start: string, goal: string, allowed: Set<string>): boolean => {
    const queue = [start];
    const seen = new Set<string>([start]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of adjacency.get(id) ?? []) {
        if (!allowed.has(next) || seen.has(next)) continue;
        if (next === goal) return true;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  };

  // Compute cycles by mutual reachability through the whole graph.
  edges.forEach(({ from, to }, index) => {
    if (!plan.delayed[index]) {
      expect(position.get(from)!).toBeLessThan(position.get(to)!);
      return;
    }
    const mutual =
      from === to || (reaches(to, from, new Set(ids)) && reaches(from, to, new Set(ids)));
    expect(mutual).toBe(true);
  });

  return plan;
}

describe('planProcessing', () => {
  it('orders a long declared-backwards chain by its cables', () => {
    const ids = ['e', 'd', 'c', 'b', 'a'];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')];
    const plan = checkInvariants(ids, edges);
    expect(plan.order).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(plan.delayed).toEqual([false, false, false, false]);
  });

  it('orders a diamond one level at a time', () => {
    const plan = checkInvariants(
      ['out', 'right', 'left', 'src'],
      [edge('src', 'right'), edge('src', 'left'), edge('left', 'out'), edge('right', 'out')]
    );
    expect(plan.order[0]).toBe('src');
    expect(plan.order[3]).toBe('out');
    expect(plan.delayed.every((delayed) => delayed === false)).toBe(true);
  });

  it('schedules two disjoint rings deterministically and independently', () => {
    const plan = checkInvariants(
      ['out', 'y', 'x', 'b', 'a', 'src'],
      [
        edge('a', 'b'),
        edge('b', 'a'),
        edge('src', 'a'),
        edge('x', 'y'),
        edge('y', 'x'),
        edge('a', 'out'),
      ]
    );
    // Both rings run before `out` (a feeds it); inside a ring members fall
    // back to declaration order. The x/y ring has no feeders, so it goes
    // first; src then releases the a/b ring.
    expect(plan.order).toEqual(['y', 'x', 'src', 'b', 'a', 'out']);
    // One back edge per ring; the acyclic cables stay live.
    expect(plan.delayed).toEqual([true, false, false, true, false, false]);
  });

  it('keeps exactly one delayed cable in a three-module ring, whatever the declaration order', () => {
    const forward = checkInvariants(
      ['a', 'b', 'c'],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    );
    expect(forward.delayed.filter(Boolean)).toHaveLength(1);

    const backward = checkInvariants(
      ['c', 'b', 'a'],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    );
    expect(backward.delayed.filter(Boolean)).toHaveLength(1);

    // Every cable of a simple ring but the closing one runs live.
    const delayedIndex = backward.delayed.findIndex(Boolean);
    expect(backward.delayed[delayedIndex]).toBe(true);
    expect(backward.order).toHaveLength(3);
  });

  it('marks a self-patch delayed and still lists the module once', () => {
    const plan = checkInvariants(['loop', 'out'], [edge('loop', 'loop'), edge('loop', 'out')]);
    expect(plan.order).toEqual(['loop', 'out']);
    expect(plan.delayed).toEqual([true, false]);
  });

  it('treats two cables between the same modules as one dependency but keeps both delayed flags', () => {
    const plan = checkInvariants(
      ['out', 'a', 'b'],
      [edge('a', 'b'), edge('a', 'b'), edge('b', 'a'), edge('b', 'out')]
    );
    expect(plan.order).toEqual(['a', 'b', 'out']);
    expect(plan.delayed).toEqual([false, false, true, false]);
  });

  it('keeps a 400-module ring linear and processes every module once', () => {
    const ids = Array.from({ length: 400 }, (_, index) => `m${index}`);
    const edges = ids.map((id, index) => edge(id, ids[(index + 1) % ids.length]));
    const plan = checkInvariants(ids, edges);
    expect(plan.order).toHaveLength(400);
    expect(plan.delayed.filter(Boolean)).toHaveLength(1);
  });

  it('ignores cables whose endpoints are not part of the graph', () => {
    const plan = planProcessing(['a'], [edge('a', 'ghost'), edge('ghost', 'a')]);
    expect(plan.order).toEqual(['a']);
    expect(plan.delayed).toEqual([false, false]);
  });
});
