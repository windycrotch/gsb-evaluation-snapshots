import type * as THREE from 'three';
import type { SceneObject } from '../types/editor';
import type { SceneAIConfig, createSceneAI } from './SceneAI';
import type { SceneTimeline } from '../types/timeline';
import type { getPhysicsBounds } from './PhysicsEngine';

export function createPathFollowers(
  objects: SceneObject[],
  config: SceneAIConfig | undefined,
  timeline: SceneTimeline | undefined,
  makeAI: typeof createSceneAI,
  reportError: (message: string) => void,
  three: typeof THREE,
  getBounds: typeof getPhysicsBounds,
  reportRecovery?: (message: string) => void
) {
  type Point = [number, number];
  type Obstacle = { minX: number; maxX: number; minZ: number; maxZ: number };
  type Follower = {
    item: SceneObject;
    path: Point[];
    speed: number;
    cellSize: number;
    originX: number;
    originZ: number;
    faceDirection: boolean;
    avoidObstacles: boolean;
    algorithm: 'astar' | 'dijkstra' | 'q';
    next: number;
    direction: number;
    checkTime: number;
    waiting: boolean;
    failed: boolean;
  };
  const followers: Follower[] = [];
  for (const item of objects) {
    const options = item.properties.pathFollower;
    if (!options?.enabled) continue;
    try {
      if (!config) throw new Error('Save scene AI grid settings first.');
      if (item.properties.web) throw new Error('Path following requires a 3D object.');
      if ((item.properties.physics?.enabled && !item.properties.physics.isKinematic) || item.properties.characterController?.enabled) {
        throw new Error('Use kinematic physics and disable the character controller on a path follower.');
      }
      if (item.properties.animations?.some(animation =>
        animation.type === 'movement' && animation.autoPlay ||
        options.faceDirection && animation.type === 'rotation' &&
          (animation.autoPlay || animation.trigger?.type === 'mouseWheel'))) {
        throw new Error('Disable conflicting movement or rotation animations on this path follower.');
      }
      if (timeline?.tracks.some(track => track.targetId === item.id &&
          (['position.x', 'position.z'].includes(track.property) ||
            options.faceDirection && track.property === 'rotation.y'))) {
        throw new Error('Remove conflicting X/Z position or Y rotation timeline channels from this path follower.');
      }
      if (!Number.isFinite(options.speed) || options.speed < 0.1 || options.speed > 100 ||
          !Number.isFinite(options.cellSize) || options.cellSize < 0.1 || options.cellSize > 1000 ||
          !['astar', 'dijkstra', 'q'].includes(options.algorithm)) {
        throw new Error('Invalid path follower settings.');
      }
      const ai = makeAI(config);
      let path: Point[];
      if (options.algorithm === 'q') {
        const learned = ai.train();
        if (!learned.reachedGoal) throw new Error('Q-learning did not find a path to the goal.');
        path = learned.path;
      } else {
        path = ai.findPath(options.algorithm).path;
        if (!path.length) throw new Error('The goal is unreachable on the AI grid.');
      }
      if (path.length < 2) continue;
      followers.push({
        item, path, speed: options.speed, cellSize: options.cellSize,
        originX: item.object.position.x - config.start[0] * options.cellSize,
        originZ: item.object.position.z - config.start[1] * options.cellSize,
        faceDirection: options.faceDirection, avoidObstacles: options.avoidObstacles ?? false,
        algorithm: options.algorithm, next: 1, direction: 1, checkTime: 0, waiting: false, failed: false
      });
    } catch (error) {
      reportError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function world(follower: Follower, point: Point): Point {
    return [follower.originX + point[0] * follower.cellSize, follower.originZ + point[1] * follower.cellSize];
  }

  function obstaclesFor(follower: Follower): Obstacle[] {
    const own = getBounds(follower.item, three);
    if (own.isEmpty()) throw new Error('A path follower needs non-empty collider bounds.');
    const position = follower.item.object.position;
    const result: Obstacle[] = [];
    for (const other of objects) {
      if (other.id === follower.item.id || !other.properties.physics?.enabled || other.properties.physics.isTrigger) continue;
      const box = getBounds(other, three);
      if (box.isEmpty() || box.max.y <= own.min.y + 1e-6 || box.min.y >= own.max.y - 1e-6) continue;
      result.push({
        minX: box.min.x - (own.max.x - position.x) - 1e-5,
        maxX: box.max.x - (own.min.x - position.x) + 1e-5,
        minZ: box.min.z - (own.max.z - position.z) - 1e-5,
        maxZ: box.max.z - (own.min.z - position.z) + 1e-5
      });
    }
    return result;
  }

  function clear(from: Point, to: Point, obstacles: Obstacle[]) {
    return !obstacles.some(box => {
      let low = 0;
      let high = 1;
      for (const [start, end, min, max] of [
        [from[0], to[0], box.minX, box.maxX], [from[1], to[1], box.minZ, box.maxZ]
      ]) {
        const delta = end - start;
        if (Math.abs(delta) < 1e-10) {
          if (start < min || start > max) return false;
        } else {
          const a = (min - start) / delta;
          const b = (max - start) / delta;
          low = Math.max(low, Math.min(a, b));
          high = Math.min(high, Math.max(a, b));
          if (low > high) return false;
        }
      }
      return true;
    });
  }

  function replan(follower: Follower, obstacles: Obstacle[]) {
    if (!config) return false;
    const goal = follower.direction > 0 ? config.goal : config.start;
    const position: Point = [follower.item.object.position.x, follower.item.object.position.z];
    const grid = config.grid.map((row, z) => row.map((cell, x) =>
      cell || !clear(world(follower, [x, z]), world(follower, [x, z]), obstacles) ? 1 : 0));
    if (grid[goal[1]][goal[0]]) return false;
    const candidates: Point[] = [];
    for (const index of [follower.next - 1, follower.next]) {
      const point = follower.path[index];
      if (point && grid[point[1]]?.[point[0]] === 0 && clear(position, world(follower, point), obstacles)) {
        candidates.push(point);
      }
    }
    candidates.sort((a, b) => {
      const pa = world(follower, a);
      const pb = world(follower, b);
      return Math.hypot(pa[0] - position[0], pa[1] - position[1]) - Math.hypot(pb[0] - position[0], pb[1] - position[1]);
    });
    const canMove = (from: Point, to: Point) => clear(world(follower, from), world(follower, to), obstacles);
    for (const start of candidates) {
      const ai = makeAI({ ...config, grid, start, goal }, canMove);
      const reachable = ai.findPath(follower.algorithm === 'dijkstra' ? 'dijkstra' : 'astar').path;
      if (!reachable.length) continue;
      const learned = follower.algorithm === 'q' ? ai.train() : undefined;
      if (learned && !learned.reachedGoal) return false;
      follower.path = learned ? learned.path : reachable;
      const first = world(follower, follower.path[0]);
      follower.next = Math.hypot(first[0] - position[0], first[1] - position[1]) < 1e-8 ? 1 : 0;
      if (follower.waiting) reportRecovery?.(`${follower.item.name}: No usable route around scene colliders; waiting and retrying.`);
      follower.waiting = false;
      return true;
    }
    return false;
  }

  function blocked(follower: Follower, obstacles: Obstacle[]) {
    let from: Point = [follower.item.object.position.x, follower.item.object.position.z];
    for (let index = follower.next; index < follower.path.length; index++) {
      const to = world(follower, follower.path[index]);
      if (!clear(from, to, obstacles)) return true;
      from = to;
    }
    return false;
  }

  return {
    update(delta: number) {
      if (!Number.isFinite(delta) || delta <= 0) return;
      for (const follower of followers) {
        if (follower.failed) continue;
        try {
          let obstacles = follower.avoidObstacles ? obstaclesFor(follower) : [];
          follower.checkTime -= delta;
          if (follower.avoidObstacles && follower.checkTime <= 0) {
            follower.checkTime = 0.25;
            if ((follower.waiting || blocked(follower, obstacles)) && !replan(follower, obstacles)) {
              if (!follower.waiting) reportError(`${follower.item.name}: No usable route around scene colliders; waiting and retrying.`);
              follower.waiting = true;
            }
          }
          if (follower.waiting) continue;
          let remaining = follower.speed * Math.min(delta, 0.1);
          const position = follower.item.object.position;
          while (remaining > 0) {
            if (follower.avoidObstacles && follower.next >= follower.path.length) {
              follower.direction *= -1;
              if (!replan(follower, obstacles)) {
                if (!follower.waiting) reportError(`${follower.item.name}: No usable route around scene colliders; waiting and retrying.`);
                follower.waiting = true;
                break;
              }
              if (follower.next >= follower.path.length) break;
            }
            const target = world(follower, follower.path[follower.next]);
            const dx = target[0] - position.x;
            const dz = target[1] - position.z;
            const distance = Math.hypot(dx, dz);
            if (distance > 1e-8 && follower.faceDirection) {
              follower.item.object.rotation.y = Math.atan2(dx, dz);
              if (follower.avoidObstacles) obstacles = obstaclesFor(follower);
            }
            const step = Math.min(distance, remaining);
            const next: Point = distance > 1e-8
              ? [position.x + dx / distance * step, position.z + dz / distance * step]
              : [position.x, position.z];
            if (follower.avoidObstacles && !clear([position.x, position.z], next, obstacles)) {
              follower.checkTime = 0;
              break;
            }
            position.x = next[0];
            position.z = next[1];
            remaining -= step;
            if (distance > step) break;
            if (follower.avoidObstacles) {
              follower.next++;
            } else {
              if (follower.next === follower.path.length - 1) follower.direction = -1;
              else if (follower.next === 0) follower.direction = 1;
              follower.next += follower.direction;
            }
          }
        } catch (error) {
          follower.failed = true;
          reportError(`${follower.item.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
}
