export interface SceneAIConfig {
  grid: number[][];
  start: [number, number];
  goal: [number, number];
  learning: { episodes: number; rate: number; discount: number; exploration: number; seed: number };
  points: { x: number; y: number }[];
  predictionX: number;
}

export function createSceneAI(config: SceneAIConfig, canMove?: (from: [number, number], to: [number, number]) => boolean) {
  const settings = structuredClone(config);
  const { grid, start, goal, learning, points, predictionX } = settings;

  function validateGrid() {
    if (!Array.isArray(grid) || !grid.length || grid.length > 32 || !Array.isArray(grid[0]) ||
        !grid[0].length || grid[0].length > 32 || grid.some(row =>
          !Array.isArray(row) || row.length !== grid[0].length || row.some(cell => cell !== 0 && cell !== 1))) {
      throw new Error('Grid must be rectangular, contain 0 or 1, and be at most 32 by 32.');
    }
    for (const point of [start, goal]) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) ||
          point[0] < 0 || point[0] >= grid[0].length || point[1] < 0 || point[1] >= grid.length ||
          grid[point[1]][point[0]] !== 0) {
        throw new Error('Start and goal must be open cells inside the grid.');
      }
    }
  }

  function findPath(algorithm: 'astar' | 'dijkstra') {
    validateGrid();
    if (algorithm !== 'astar' && algorithm !== 'dijkstra') throw new Error('Unknown pathfinding algorithm.');
    const width = grid[0].length;
    const index = (x: number, y: number) => y * width + x;
    const startId = index(...start);
    const goalId = index(...goal);
    const scores = Array<number>(width * grid.length).fill(Infinity);
    const parents = Array<number>(scores.length).fill(-1);
    const open = [startId];
    const closed = new Set<number>();
    scores[startId] = 0;
    const estimate = (id: number) => algorithm === 'astar'
      ? Math.abs(id % width - goal[0]) + Math.abs(Math.floor(id / width) - goal[1]) : 0;
    while (open.length) {
      open.sort((a, b) => scores[a] + estimate(a) - scores[b] - estimate(b));
      const current = open.shift()!;
      if (current === goalId) {
        const path: [number, number][] = [];
        for (let id = current; id !== -1; id = parents[id]) path.push([id % width, Math.floor(id / width)]);
        return { path: path.reverse(), cost: scores[current] };
      }
      if (closed.has(current)) continue;
      closed.add(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= grid.length || grid[ny][nx] !== 0 ||
            (canMove && !canMove([x, y], [nx, ny]))) continue;
        const next = index(nx, ny);
        const distance = scores[current] + 1;
        if (distance < scores[next]) {
          scores[next] = distance;
          parents[next] = current;
          open.push(next);
        }
      }
    }
    return { path: [] as [number, number][], cost: null };
  }

  function train() {
    validateGrid();
    if (!learning || !Number.isInteger(learning.episodes) || learning.episodes < 1 || learning.episodes > 1000 ||
        !Number.isFinite(learning.rate) || learning.rate <= 0 || learning.rate > 1 ||
        !Number.isFinite(learning.discount) || learning.discount < 0 || learning.discount > 1 ||
        !Number.isFinite(learning.exploration) || learning.exploration < 0 || learning.exploration > 1 ||
        !Number.isInteger(learning.seed) || learning.seed < 0 || learning.seed > 4294967295) {
      throw new Error('Invalid Q-learning settings.');
    }
    const width = grid[0].length;
    const count = width * grid.length;
    const q = Array.from({ length: count }, () => [0, 0, 0, 0]);
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const target = goal[1] * width + goal[0];
    let seed = learning.seed >>> 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const move = (state: number, action: number) => {
      const x = state % width + directions[action][0];
      const y = Math.floor(state / width) + directions[action][1];
      return x >= 0 && x < width && y >= 0 && y < grid.length && grid[y][x] === 0 &&
        (!canMove || canMove([state % width, Math.floor(state / width)], [x, y])) ? y * width + x : state;
    };
    const best = (state: number) => q[state].indexOf(Math.max(...q[state]));
    let successfulEpisodes = 0;
    for (let episode = 0; episode < learning.episodes; episode++) {
      let state = start[1] * width + start[0];
      if (state === target) { successfulEpisodes++; continue; }
      for (let step = 0; step < Math.min(count * 4, 1000); step++) {
        const action = random() < learning.exploration ? Math.floor(random() * 4) : best(state);
        const next = move(state, action);
        const reward = next === target ? 25 : next === state ? -2 : -1;
        q[state][action] += learning.rate * (reward + (next === target ? 0 : learning.discount * Math.max(...q[next])) - q[state][action]);
        state = next;
        if (state === target) { successfulEpisodes++; break; }
      }
    }
    let state = start[1] * width + start[0];
    const path: [number, number][] = [[...start]];
    const visited = new Set([state]);
    while (state !== target && path.length <= count) {
      state = move(state, best(state));
      path.push([state % width, Math.floor(state / width)]);
      if (visited.has(state)) break;
      visited.add(state);
    }
    return { q, path, reachedGoal: state === target, successfulEpisodes };
  }

  function regress() {
    if (!Array.isArray(points) || points.length < 2 || points.length > 10000 ||
        points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
        !Number.isFinite(predictionX)) throw new Error('Regression needs at least two finite data points and a finite prediction value.');
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const variance = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    if (!Number.isFinite(variance) || variance <= 0) throw new Error('Regression requires different X values.');
    const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / variance;
    const intercept = meanY - slope * meanX;
    const prediction = slope * predictionX + intercept;
    if (![slope, intercept, prediction].every(Number.isFinite)) throw new Error('Regression result is not finite.');
    return { slope, intercept, prediction };
  }
  return { findPath, train, regress };
}
