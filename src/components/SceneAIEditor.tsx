import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { createSceneAI, type SceneAIConfig } from '../systems/SceneAI';
import { useEditorStore } from '../store/editorStore';

const initialConfig: SceneAIConfig = {
  grid: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0]],
  start: [0, 0], goal: [3, 2],
  learning: { episodes: 500, rate: 0.3, discount: 0.9, exploration: 0.3, seed: 1 },
  points: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }],
  predictionX: 3
};

export function SceneAIEditor() {
  const { sceneOptions, updateSceneOptions, isPlaying } = useEditorStore();
  const initial = sceneOptions.ai ?? initialConfig;
  const [grid, setGrid] = useState(initial.grid.map(row => row.join(' ')).join('\n'));
  const [start, setStart] = useState(initial.start.join(','));
  const [goal, setGoal] = useState(initial.goal.join(','));
  const [points, setPoints] = useState(initial.points.map(point => `${point.x},${point.y}`).join('\n'));
  const [learning, setLearning] = useState(initial.learning);
  const [predictionX, setPredictionX] = useState(initial.predictionX);
  const [algorithm, setAlgorithm] = useState<'astar' | 'dijkstra' | 'q' | 'regression'>('astar');
  const [result, setResult] = useState('');
  useEffect(() => {
    const config = sceneOptions.ai ?? initialConfig;
    setGrid(config.grid.map(row => row.join(' ')).join('\n'));
    setStart(config.start.join(','));
    setGoal(config.goal.join(','));
    setPoints(config.points.map(point => `${point.x},${point.y}`).join('\n'));
    setLearning(config.learning);
    setPredictionX(config.predictionX);
    setResult('');
  }, [sceneOptions.ai]);

  function parse() {
    const parsePair = (text: string): [number, number] => {
      const parts = text.split(',').map(value => value.trim());
      if (parts.length !== 2 || parts.some(value => value === '' || !Number.isFinite(Number(value)))) {
        throw new Error('Coordinates and regression rows must contain two numbers separated by a comma.');
      }
      return [Number(parts[0]), Number(parts[1])];
    };
    const cells = grid.trim().split(/\r?\n/).map(row => row.trim().split(/[\s,]+/).map(cell => {
      if (cell !== '0' && cell !== '1') throw new Error('Grid cells must be 0 or 1.');
      return Number(cell);
    }));
    return {
      grid: cells, start: parsePair(start), goal: parsePair(goal), learning,
      points: points.trim().split(/\r?\n/).map(row => { const [x, y] = parsePair(row); return { x, y }; }),
      predictionX
    };
  }

  function run(save: boolean) {
    try {
      const config = parse();
      const ai = createSceneAI(config);
      if (save) {
        ai.findPath('astar');
        ai.regress();
        ai.train();
        updateSceneOptions({ ai: config });
        toast.success('AI settings saved');
      } else {
        const output = algorithm === 'q' ? ai.train() : algorithm === 'regression' ? ai.regress() : ai.findPath(algorithm);
        setResult(JSON.stringify(output, null, 2));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invalid AI settings');
    }
  }

  return <div className="space-y-3 text-sm text-white">
    <p className="text-gray-400 text-xs">Grid: 0 is open, 1 is blocked; coordinates are X,Y. Paths use four directions.</p>
    <label className="block">Grid
      <textarea aria-label="AI grid" value={grid} onChange={event => setGrid(event.target.value)} rows={4}
        className="block w-full rounded bg-gray-700 p-2 font-mono" />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <label>Start X,Y<input aria-label="AI start" value={start} onChange={event => setStart(event.target.value)} className="block w-full rounded bg-gray-700 p-2" /></label>
      <label>Goal X,Y<input aria-label="AI goal" value={goal} onChange={event => setGoal(event.target.value)} className="block w-full rounded bg-gray-700 p-2" /></label>
    </div>
    <fieldset className="space-y-2 rounded border border-gray-600 p-2">
      <legend>Q-learning</legend>
      {([
        ['episodes', 'Episodes', 1, 1000, 1],
        ['rate', 'Learning rate', 0.001, 1, 0.1],
        ['discount', 'Discount', 0, 1, 0.1],
        ['exploration', 'Exploration', 0, 1, 0.1],
        ['seed', 'Seed', 0, 4294967295, 1]
      ] as const).map(([field, label, min, max, step]) => <label key={field} className="flex items-center justify-between gap-2">
        {label}<input aria-label={`AI ${label}`} type="number" min={min} max={max} step={step} value={learning[field]}
          onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) setLearning({ ...learning, [field]: event.target.valueAsNumber }); }}
          className="w-24 rounded bg-gray-700 p-1" />
      </label>)}
    </fieldset>
    <label className="block">Regression data (one X,Y pair per line)
      <textarea aria-label="AI regression data" rows={3} value={points} onChange={event => setPoints(event.target.value)}
        className="block w-full rounded bg-gray-700 p-2 font-mono" />
    </label>
    <label className="block">Prediction X
      <input aria-label="AI prediction X" type="number" value={predictionX}
        onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) setPredictionX(event.target.valueAsNumber); }}
        className="block w-full rounded bg-gray-700 p-2" />
    </label>
    <div className="flex flex-wrap gap-2">
      <select aria-label="AI algorithm" value={algorithm} onChange={event => setAlgorithm(event.target.value as typeof algorithm)}
        className="rounded bg-gray-700 p-2">
        <option value="astar">A*</option><option value="dijkstra">Dijkstra</option>
        <option value="q">Q-learning</option><option value="regression">Linear regression</option>
      </select>
      <button type="button" className="rounded bg-gray-600 px-2" onClick={() => run(false)}>Run algorithm</button>
      <button type="button" disabled={isPlaying} className="rounded bg-blue-700 px-2 disabled:opacity-50" onClick={() => run(true)}>Save AI settings</button>
    </div>
    {result && <pre aria-label="AI result" className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-2">{result}</pre>}
    <p className="text-gray-400 text-xs">Object scripts can use state.ai.findPath('astar' or 'dijkstra'), state.ai.train() and state.ai.regress().</p>
  </div>;
}
