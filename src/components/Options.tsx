import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'react-hot-toast';
import { useEditorStore } from '../store/editorStore';
import { parseSceneProposal, prepareSceneAdditions, sceneAgentContext, type SceneProposal } from '../services/sceneAgent';

type Provider = 'openai' | 'ollama' | 'gemini' | 'claude' | 'openrouter' | 'lmstudio' | 'anythingllm';
const defaults: Record<Provider, string> = {
  openai: 'gpt-4o-mini', ollama: 'llama3.2', gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-4-5',
  openrouter: 'openai/gpt-4o-mini', lmstudio: 'local-model', anythingllm: 'your-workspace-slug'
};

export function Options({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>('ollama');
  const [model, setModel] = useState(defaults.ollama);
  const [models, setModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState('Loading models...');
  const [modelRefresh, setModelRefresh] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState('');
  const [codeTarget, setCodeTarget] = useState<{ kind: 'object' | 'web'; id?: string }>();
  const [loading, setLoading] = useState(false);
  const [agentStage, setAgentStage] = useState('');
  const [thinking, setThinking] = useState(true);
  const [temperature, setTemperature] = useState('');
  const [mode, setMode] = useState<'single' | 'scene'>('single');
  const [screenshot, setScreenshot] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [proposal, setProposal] = useState<{ value: SceneProposal; snapshot: ReturnType<typeof useEditorStore.getState> }>();
  const selectedObject = useEditorStore(state => state.selectedObject);

  useEffect(() => {
    const controller = new AbortController();
    setModels([]);
    setModelStatus(provider === 'anythingllm' ? 'Loading workspaces...' : 'Loading models...');
    void fetch('/api/ai/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }), signal: controller.signal
    }).then(async response => {
      const data: { models?: string[]; error?: string } = await response.json();
      if (!response.ok || !Array.isArray(data.models) || data.models.some(item => typeof item !== 'string')) {
        throw new Error(data.error || 'Invalid model list');
      }
      if (controller.signal.aborted) return;
      const available = data.models;
      setModels(available);
      setModel(current => current === defaults[provider] && available.length && !available.includes(current) ? available[0] : current);
      setModelStatus(available.length ? `${available.length} available` : 'No models found; enter a model manually.');
    }).catch(error => {
      if (controller.signal.aborted) return;
      setModelStatus(`${error instanceof Error ? error.message : 'Model listing failed'} Enter a model manually or retry.`);
    });
    return () => controller.abort();
  }, [provider, modelRefresh]);

  async function captureScreenshot() {
    let stream: MediaStream | undefined;
    const video = document.createElement('video');
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is not available in this browser.');
      flushSync(() => setCapturing(true));
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!video.videoWidth || !video.videoHeight) throw new Error('Could not read the selected screen.');
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not capture the selected screen.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setScreenshot(canvas.toDataURL('image/jpeg', 0.75));
    } catch (error) {
      console.error('Screen capture failed:', error);
      toast.error(error instanceof Error ? error.message : 'Screen capture failed');
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      setCapturing(false);
    }
  }

  async function generate() {
    if (!prompt.trim()) { toast.error('Enter a prompt'); return; }
    const temperatureValue = temperature.trim() === '' ? undefined : Number(temperature);
    if (provider === 'ollama' && temperatureValue !== undefined &&
        (!Number.isFinite(temperatureValue) || temperatureValue < 0 || temperatureValue > 2)) {
      toast.error('Temperature must be between 0 and 2');
      return;
    }
    const snapshot = useEditorStore.getState();
    if (snapshot.isPlaying) { toast.error('Stop Play before using the code assistant.'); return; }
    const targetKind = snapshot.selectedObject?.properties.web ? 'web' : 'object';
    const disclosure = mode === 'scene'
      ? ` Scene names, object properties and scripts across scenes, timeline settings, asset metadata${screenshot ? ', and the captured screenshot' : ''} will be sent.`
      : ` The prompt and target type (${targetKind === 'web' ? 'web component' : '3D object'}) will be sent.`;
    if (!window.confirm(`Send to ${provider === 'ollama' ? 'the configured local Ollama server' : provider}?${disclosure}`)) return;
    setLoading(true);
    setAgentStage('Sending context to the selected provider and waiting for its response...');
    setProposal(undefined);
    setCode('');
    setCodeTarget(undefined);
    try {
      const response = await fetch('/api/ai/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model, prompt, ...(provider === 'ollama' ? { thinking, temperature: temperatureValue } : {}),
          ...(mode === 'scene' ? {
            mode: 'scene-agent', screenshot,
            context: sceneAgentContext(snapshot.sceneObjects, snapshot.assets, snapshot.scenes, snapshot.activeSceneId,
              snapshot.sceneOptions, snapshot.selectedObject?.id)
          } : { targetKind }) })
      });
      const data: { code?: string; error?: string } = await response.json();
      if (!response.ok || !data.code) throw new Error(data.error || 'No code returned');
      if (mode === 'scene') {
        setProposal({ value: parseSceneProposal(data.code, snapshot.sceneObjects, snapshot.assets, snapshot.sceneOptions.timeline,
          snapshot.scenes, snapshot.activeSceneId), snapshot });
        setAgentStage('Proposal validated. Review the changes before applying.');
      }
      else {
        setCode(data.code);
        setCodeTarget({ kind: targetKind, id: snapshot.selectedObject?.id });
        setAgentStage('Code received. Review it before applying.');
      }
    } catch (error) {
      setAgentStage('Generation failed; no changes were applied.');
      console.error('Code generation failed:', error);
      toast.error(error instanceof Error ? error.message : 'Code generation failed');
    } finally { setLoading(false); }
  }

  async function applyProposal() {
    if (!proposal || applying) return;
    const before = proposal.snapshot;
    const unchanged = () => {
      const current = useEditorStore.getState();
      return !current.isPlaying && current.activeSceneId === before.activeSceneId && current.sceneObjects === before.sceneObjects &&
        current.sceneOptions === before.sceneOptions && current.scenes === before.scenes && current.assets === before.assets;
    };
    if (!unchanged()) { toast.error('The scene or asset library changed. Generate a new proposal before applying.'); return; }
    setApplying(true);
    setAgentStage('Preparing assets and applying the reviewed changes...');
    try {
      const additions = await prepareSceneAdditions(proposal.value.additions, before.assets);
      if (!unchanged()) throw new Error('The scene or asset library changed while preparing assets. Generate a new proposal.');
      useEditorStore.getState().applySceneAgentChanges(proposal.value.edits, proposal.value.removals, additions, proposal.value.timelineTracks);
      toast.success('Reviewed scene changes applied');
      setProposal(undefined);
      onClose();
    } catch (error) {
      setAgentStage('Applying the proposal failed; no changes were applied.');
      console.error('Failed to apply scene changes:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to apply scene changes');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className={`fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 ${capturing ? 'invisible' : ''}`}>
      <div role="dialog" aria-modal="true" aria-labelledby="options-title" className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded bg-gray-800 p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 id="options-title" className="text-lg font-bold">Options &amp; Code Assistant</h2>
          <button aria-label="Close options" disabled={applying} onClick={onClose} className="p-2">Close</button>
        </div>
        <div className="space-y-3">
          <label className="block">Assistant mode
            <select aria-label="Assistant mode" disabled={loading || applying} value={mode} onChange={event => {
              setMode(event.target.value as 'single' | 'scene'); setProposal(undefined);
              setCode(''); setCodeTarget(undefined); setAgentStage('');
            }} className="block w-full bg-gray-700 p-2 rounded">
              <option value="single">Selected object code</option>
              <option value="scene">Scene agent (review changes)</option>
            </select>
          </label>
          <label className="block">Provider
            <select aria-label="AI provider" disabled={loading || applying} value={provider} onChange={(event) => {
              const next = event.target.value as Provider;
              setProvider(next); setModel(defaults[next]);
            }} className="block w-full bg-gray-700 p-2 rounded">
              <option value="ollama">Ollama</option><option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option><option value="claude">Claude</option>
              <option value="openrouter">OpenRouter</option><option value="lmstudio">LM Studio</option>
              <option value="anythingllm">AnythingLLM</option>
            </select>
          </label>
          <label className="block">{provider === 'anythingllm' ? 'Workspace slug' : 'Model'}
            <input list="ai-model-list" aria-label={provider === 'anythingllm' ? 'AnythingLLM workspace slug' : 'AI model'} disabled={loading || applying} value={model} onChange={event => setModel(event.target.value)} className="block w-full bg-gray-700 p-2 rounded" />
            <datalist id="ai-model-list">{models.map(item => <option value={item} key={item} />)}</datalist>
            <span role="status" className="text-xs text-gray-300">{modelStatus}</span>
            <button type="button" disabled={loading || applying} onClick={() => setModelRefresh(value => value + 1)} className="ml-2 text-xs underline">Refresh models</button>
          </label>
          {provider === 'ollama' && (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" disabled={loading || applying} checked={thinking} onChange={event => setThinking(event.target.checked)} />
                Enable model reasoning
              </label>
              <label className="block">Temperature (optional, 0–2)
                <input aria-label="Ollama temperature" disabled={loading || applying} type="number" min="0" max="2" step="0.1" value={temperature} onChange={event => setTemperature(event.target.value)} className="block w-full bg-gray-700 p-2 rounded" />
              </label>
            </>
          )}
          <p className="text-xs text-gray-300">Set provider API keys in the local server environment; keys are not stored in projects. Ollama, LM Studio and AnythingLLM connect to local servers. Local services may forward prompts and scene data to remote model providers; OpenRouter is a remote service. AnythingLLM uses the model configured in its workspace.</p>
          {provider === 'openrouter' && <p className="text-xs text-gray-300">Set OPENROUTER_API_KEY before starting the editor server.</p>}
          {provider === 'lmstudio' && <p className="text-xs text-gray-300">Start the local LM Studio server on port 1234. Optional: LM_STUDIO_BASE_URL and LM_STUDIO_API_KEY.</p>}
          {provider === 'anythingllm' && <p className="text-xs text-gray-300">Start AnythingLLM locally, set ANYTHINGLLM_API_KEY, and enter its workspace slug. Optional: ANYTHINGLLM_BASE_URL.</p>}
          {mode === 'scene' && <>
            <p className="text-xs text-gray-300">The agent sees scenes, objects, scripts, timeline settings, GLB clip metadata and asset metadata. Embedded media is omitted, but scripts or text may contain sensitive data. Changes apply only to the active scene after review; other scenes are read-only context. Assets remain in the library.</p>
            <p className="text-xs text-gray-300">Context: {useEditorStore.getState().scenes.length} scenes, {useEditorStore.getState().sceneObjects.length} active objects, {useEditorStore.getState().assets.length} assets, {useEditorStore.getState().sceneOptions.timeline?.tracks.length ?? 0} timeline tracks.</p>
            <p className="text-xs text-amber-300">Screen capture may include anything visible on the chosen tab or screen. Sharing it with a provider requires a vision-capable model.</p>
            <button type="button" disabled={loading || capturing || applying} onClick={() => void captureScreenshot()} className="rounded bg-gray-700 px-3 py-2">Capture screen</button>
            {screenshot && <div>
              <img src={screenshot} alt="Captured screen preview" className="max-h-40 max-w-full" />
              <button type="button" disabled={loading || applying} onClick={() => setScreenshot(undefined)} className="text-sm text-red-300">Remove screenshot</button>
            </div>}
          </>}
          {mode === 'single' && <p className="text-xs text-gray-300">
            Target: {selectedObject ? `${selectedObject.name} (${selectedObject.properties.web ? 'web component' : '3D object'})` : 'no object selected; 3D object code will be generated'}.
            Applying replaces the selected object's existing script.
          </p>}
          <label className="block">Prompt
            <textarea aria-label="AI prompt" disabled={loading || applying} rows={10} maxLength={100000} value={prompt} onChange={event => setPrompt(event.target.value)} className="block w-full resize-y bg-gray-700 p-2 rounded" />
            <span className="text-xs text-gray-400">{prompt.length} / 100000 characters</span>
          </label>
          <button disabled={loading || applying} onClick={() => void generate()} className="bg-blue-600 px-4 py-2 rounded disabled:opacity-50">{loading ? 'Generating...' : 'Generate code'}</button>
          {agentStage && <p role="status" className="text-sm text-gray-300">{agentStage}</p>}
          {mode === 'single' && code && <>
            {selectedObject && <details className="text-xs text-gray-300"><summary>Current script</summary>
              <pre className="whitespace-pre-wrap break-all">{selectedObject.properties.web?.script ?? selectedObject.properties.script ?? '(empty)'}</pre>
            </details>}
            <label className="block">Generated code
              <textarea aria-label="Generated code" rows={10} value={code} onChange={event => setCode(event.target.value)} className="block w-full bg-gray-900 font-mono p-2 rounded" />
            </label>
            <button disabled={!selectedObject || loading || applying} onClick={() => {
              const current = useEditorStore.getState();
              const target = current.selectedObject;
              if (!target || !codeTarget) return;
              if (current.isPlaying) { toast.error('Stop Play before applying code.'); return; }
              if ((target.properties.web ? 'web' : 'object') !== codeTarget.kind || (codeTarget.id && codeTarget.id !== target.id)) {
                toast.error('The selected target changed. Generate code again for the selected object.');
                return;
              }
              try {
                new Function(target.properties.web ? 'element' : 'object', 'scene', 'camera', 'THREE', 'state', 'openScene', 'scenes', code);
              } catch (error) {
                toast.error(`Invalid JavaScript: ${error instanceof Error ? error.message : String(error)}`);
                return;
              }
              current.updateObjectProperties(target.id, target.properties.web
                ? { web: { ...target.properties.web, script: code } } : { script: code });
              toast.success(`Applied code to ${target.name}`);
              onClose();
            }} className="bg-green-700 px-4 py-2 rounded disabled:opacity-50">Apply to selected object</button>
          </>}
          {mode === 'scene' && proposal && <section aria-label="Scene change proposal" className="space-y-2 rounded border border-gray-600 p-3">
            <p>{proposal.value.summary}</p>
            {proposal.value.timelineTracks.map(track => <p key={track.id} className="text-sm text-cyan-300">
              Add timeline: {proposal.snapshot.sceneObjects.find(item => item.id === track.targetId)?.name} / {track.property}
              {' — '}{track.keyframes.map(frame => `${frame.time}s: ${frame.value}${frame.easing ? ` (${frame.easing})` : ''}`).join(', ')}
            </p>)}
            {proposal.value.removals.map(id => {
              const item = proposal.snapshot.sceneObjects.find(object => object.id === id)!;
              return <p key={id} className="text-sm text-red-300">Remove from scene: {item.name} ({item.type}). Web children are reparented; deleting the active camera clears its selection.</p>;
            })}
            {proposal.value.additions.map((addition, index) => <div key={index} className="space-y-1">
              <p className="text-sm text-emerald-300">Add: {addition.name} ({addition.kind === 'asset'
                ? `${proposal.snapshot.assets.find(asset => asset.id === addition.assetId)?.name} as ${addition.usage}`
                : addition.type}){addition.kind !== 'primitive' && addition.parentId
                  ? ` to ${proposal.snapshot.sceneObjects.find(object => object.id === addition.parentId)?.name}` : ''}</p>
              {addition.kind !== 'web' && addition.position && <p className="text-xs">Position: {addition.position.join(', ')}</p>}
              {addition.kind === 'web' && addition.text !== undefined && <p className="text-xs">Text: {addition.text}</p>}
              {addition.kind === 'web' && addition.sceneId && <p className="text-xs">
                Destination: {proposal.snapshot.scenes.find(scene => scene.id === addition.sceneId)?.sceneOptions.name}
              </p>}
              {addition.javascript !== undefined && <label className="block text-xs">JavaScript
                <textarea readOnly value={addition.javascript} rows={4} className="block w-full bg-gray-900 font-mono p-2" />
              </label>}
              {addition.kind !== 'primitive' && addition.css !== undefined && <label className="block text-xs">CSS declarations
                <textarea readOnly value={addition.css} rows={3} className="block w-full bg-gray-900 font-mono p-2" />
              </label>}
            </div>)}
            {proposal.value.edits.map(edit => {
              const item = proposal.snapshot.sceneObjects.find(object => object.id === edit.objectId)!;
              return <div key={edit.objectId} className="space-y-1">
                <h3 className="font-semibold">{item.name} ({item.type})</h3>
                {edit.web && <pre className="whitespace-pre-wrap text-xs">Web settings: {JSON.stringify(edit.web, null, 2)}</pre>}
                <details className="text-xs text-gray-300"><summary>Current code</summary>
                  {edit.javascript !== undefined && <pre className="whitespace-pre-wrap break-all">{item.properties.web?.script ?? item.properties.script ?? '(empty)'}</pre>}
                  {edit.css !== undefined && <pre className="whitespace-pre-wrap break-all">{item.properties.web?.customCss || '(empty)'}</pre>}
                </details>
                {edit.javascript !== undefined && <label className="block text-xs">JavaScript (replacement; empty removes it)
                  <textarea readOnly aria-label={`Proposed JavaScript for ${item.name}`} value={edit.javascript} rows={5} className="block w-full bg-gray-900 font-mono p-2" />
                </label>}
                {edit.css !== undefined && <label className="block text-xs">CSS declarations (replacement; empty removes them)
                  <textarea readOnly aria-label={`Proposed CSS for ${item.name}`} value={edit.css} rows={4} className="block w-full bg-gray-900 font-mono p-2" />
                </label>}
              </div>;
            })}
            <button type="button" disabled={applying} onClick={() => void applyProposal()} className="bg-green-700 px-4 py-2 rounded disabled:opacity-50">{applying ? 'Preparing assets...' : 'Apply reviewed changes'}</button>
          </section>}
        </div>
      </div>
    </div>
  );
}
