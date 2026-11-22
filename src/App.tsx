import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Viewport } from './components/Viewport';
import { Sidebar } from './components/Sidebar';
import { Properties } from './components/Properties';
import { AssetPanel } from './components/AssetPanel';
import { SceneObjectsList } from './components/SceneObjectsList';
import { SceneOptions } from './components/SceneOptions';
import { Download, Save, Play, Square, Menu, X, PanelRightOpen, FolderOpen, Trash2, Settings, Undo2, Redo2 } from 'lucide-react';
import { Options } from './components/Options';
import { createEmptyScene, createProjectSnapshot, useEditorStore } from './store/editorStore';
import type { ExportFormat } from './services/sceneExporter';
import { exportScene, isExportAbortError } from './services/sceneExporter';
import { ExportValidationError } from './services/exportValidation';
import { deleteProject, getProjects, saveProject, updateProject, type ProjectData } from './services/database';
import { toast } from 'react-hot-toast';
import { readEditor } from './services/sceneStorage';
import { beginNewDraft, disableHistory, flushHistory, initializeHistory, moveHistory, transferHistory, useHistoryStatus } from './services/editorHistory';

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectData[] | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('html');
  const exportRequestId = useRef(0);
  const [restoring, setRestoring] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { sceneObjects, isPlaying, startPlay, stopPlay } = useEditorStore();
  const history = useHistoryStatus();

  useEffect(() => {
    let active = true;
    void readEditor().then(async (stored) => {
      if (!active) return;
      if (stored) {
        await useEditorStore.getState().loadScene(stored.currentScene);
        if (!active) return;
        useEditorStore.getState().setAssets(stored.assets);
      }
      await initializeHistory(useEditorStore.getState().currentProjectId);
    }).catch((error) => {
      if (active) {
        console.error('Failed to load scene:', error);
        toast.error('Failed to restore the saved scene');
      }
    }).finally(() => {
      if (active) setRestoring(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey) || event.altKey || isPlaying) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      const key = event.key.toLowerCase();
      const direction = key === 'z' ? (event.shiftKey ? 1 : -1) : key === 'y' ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      void moveHistory(direction);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isPlaying]);

  const handleExport = async () => {
    // A newer click (e.g. switching format and exporting again) supersedes the
    // in-flight run; the exporter aborts the old one before it can download.
    const requestId = ++exportRequestId.current;
    flushSync(() => setExporting(true));
    try {
      const { sceneObjects: currentObjects, sceneOptions, assets } = useEditorStore.getState();
      const snapshot = { ...createProjectSnapshot(currentObjects, sceneOptions), assets: structuredClone(assets) };
      await exportScene(snapshot, exportFormat);
      if (requestId === exportRequestId.current) toast.success('Scene exported successfully!');
    } catch (error) {
      // Superseded/unloaded exports are normal control flow, not user-facing errors.
      if (isExportAbortError(error)) return;
      console.error('Export error:', error);
      if (error instanceof ExportValidationError) {
        toast(error.message, {
          duration: 8000,
          style: { whiteSpace: 'pre-line', textAlign: 'left', maxWidth: '32rem' }
        });
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to export scene');
      }
    } finally {
      if (requestId === exportRequestId.current) setExporting(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      let historyUnavailable = !useHistoryStatus.getState().ready;
      try {
        await flushHistory();
      } catch (error) {
        historyUnavailable = true;
        console.error('History could not be flushed before saving:', error);
      }
      const state = useEditorStore.getState();
      const project = {
        name: state.sceneOptions.name.trim(),
        sceneData: { ...createProjectSnapshot(state.sceneObjects, state.sceneOptions), assets: structuredClone(state.assets) },
      };
      if (!project.name) throw new Error('Enter a scene name before saving the project.');
      await state.saveScene();
      const result = state.currentProjectId
        ? await updateProject(state.currentProjectId, project)
        : await saveProject(project);
      const current = useEditorStore.getState();
      if (current.currentProjectId === state.currentProjectId &&
          current.sceneObjects === state.sceneObjects &&
          current.sceneOptions === state.sceneOptions &&
          current.scenes === state.scenes &&
          current.assets === state.assets &&
          current.activeSceneId === state.activeSceneId) {
        if (!state.currentProjectId && !historyUnavailable) {
          try {
            await transferHistory(result.id);
          } catch (error) {
            historyUnavailable = true;
            disableHistory(error);
            console.error('History could not be transferred to the saved project:', error);
          }
        }
        current.setCurrentProjectId(result.id);
        if (historyUnavailable) {
          toast.error('Project saved, but history is unavailable. Reload before continuing.');
        } else {
          toast.success('Project saved');
        }
      } else {
        toast.success('Project saved; the current project changed during saving.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save project');
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleShowProjects = async () => {
    try {
      setProjects(await getProjects());
    } catch (error) {
      toast.error('Failed to load projects');
      console.error('Project list error:', error);
    }
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) { toast.error('Enter a project name.'); return; }
    if (!window.confirm('Create a new empty project? Current local scenes and assets will be replaced. Save any changes you want to keep first.')) return;
    setRestoring(true);
    try {
      await flushHistory();
      const sceneData = createEmptyScene(name);
      const project = await saveProject({ name, sceneData });
      await useEditorStore.getState().loadScene(sceneData);
      useEditorStore.getState().setAssets([]);
      useEditorStore.getState().setCurrentProjectId(project.id);
      await useEditorStore.getState().saveScene();
      await initializeHistory(project.id);
      setProjects(null);
      setNewProjectName('');
      toast.success('New project created');
    } catch (error) {
      console.error('Create project error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create project');
    } finally {
      setRestoring(false);
    }
  };

  const handleOpenProject = async (project: ProjectData) => {
    if (!window.confirm(`Open "${project.name}"? The current local scenes and, when included, the asset library will be replaced.`)) return;
    setRestoring(true);
    try {
      await flushHistory();
      const state = useEditorStore.getState();
      const assets = project.sceneData.assets;
      if (assets !== undefined && (!Array.isArray(assets) || assets.some(asset =>
        !asset || typeof asset.id !== 'string' || typeof asset.name !== 'string' ||
        typeof asset.url !== 'string' || !['2d', '3d', 'audio', 'video'].includes(asset.type)))) {
        throw new Error('Invalid project asset data');
      }
      await state.loadScene(project.sceneData);
      if (assets) useEditorStore.getState().setAssets(assets);
      await useEditorStore.getState().saveScene();
      useEditorStore.getState().setCurrentProjectId(project.id);
      await initializeHistory(project.id);
      setProjects(null);
      toast.success('Project opened');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open project');
      console.error('Open project error:', error);
    } finally {
      setRestoring(false);
    }
  };

  const handleDeleteProject = async (project: ProjectData) => {
    if (!window.confirm(`Delete "${project.name}"?`)) return;
    try {
      await deleteProject(project.id);
      if (useEditorStore.getState().currentProjectId === project.id) {
        await beginNewDraft();
        useEditorStore.getState().setCurrentProjectId(null);
        await initializeHistory(null);
      }
      setProjects((current) => current?.filter((item) => item.id !== project.id) ?? null);
      toast.success('Project deleted');
    } catch (error) {
      toast.error('Failed to delete project');
      console.error('Delete project error:', error);
    }
  };

  const handlePlay = () => {
    if (isPlaying) {
      stopPlay();
      toast.success('Play mode stopped');
    } else {
      const { sceneOptions } = useEditorStore.getState();
      if (sceneOptions.activeCameraId && !sceneObjects.some(object => object.id === sceneOptions.activeCameraId && object.type === 'camera')) {
        toast.error('Selected play camera is unavailable; choose another camera.');
        return;
      }
      const state = useEditorStore.getState();
      const allObjects = [...sceneObjects, ...state.scenes.filter(scene => scene.id !== state.activeSceneId).flatMap(scene => scene.objects)];
      if (allObjects.some((object) => object.properties.script?.trim() || object.properties.web?.script.trim()) &&
          !window.confirm('This scene contains JavaScript with full browser access. Run only trusted code. Continue?')) return;
      startPlay();
      toast.success('Play mode started');
    }
  };

  return (
    <div className="flex h-screen min-h-0 w-full flex-col overflow-hidden bg-[#0b1220] text-slate-100">
      {(restoring || history.busy || saving) && (
        <div role="status" className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900 text-white">
          Restoring scene...
        </div>
      )}
      {/* Header */}
      <header className="relative z-50 h-14 bg-gray-800 flex items-center justify-between px-4 border-b border-gray-700 lg:col-span-full order-first shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setSidebarOpen(!sidebarOpen); setPanelOpen(false); }}
            className="lg:hidden p-2 hover:bg-gray-700 rounded transition-colors text-white"
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="hidden sm:flex items-center gap-2 min-w-0">
            <img src="/game-engine-logo.svg" alt="" className="h-9 w-9 shrink-0 rounded object-contain" />
            <h1 className="text-white text-lg lg:text-xl font-bold truncate">Game Engine Editor</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-4">
          {isPlaying && (
            <div className="flex items-center gap-2 bg-red-900 px-2 lg:px-3 py-1 rounded">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-200 text-xs lg:text-sm font-medium">PLAYING</span>
            </div>
          )}

          <div className="flex gap-1 lg:gap-2">
            {!isPlaying && <>
              <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.ready || !history.canUndo || history.busy}
                onClick={() => void moveHistory(-1)} className="rounded bg-gray-700 p-2 disabled:opacity-40"><Undo2 size={16} /></button>
              <button aria-label="Redo" title="Redo (Ctrl+Shift+Z / Ctrl+Y)" disabled={!history.ready || !history.canRedo || history.busy}
                onClick={() => void moveHistory(1)} className="rounded bg-gray-700 p-2 disabled:opacity-40"><Redo2 size={16} /></button>
            </>}
            <button
              onClick={handlePlay}
              aria-label={isPlaying ? 'Stop' : 'Play'}
              className={`flex items-center gap-1 lg:gap-2 ${
                isPlaying ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
              } text-white px-2 lg:px-4 py-2 rounded transition-colors text-xs lg:text-sm`}
            >
              {isPlaying ? <Square size={14} /> : <Play size={14} />}
              <span className="hidden sm:inline">{isPlaying ? 'Stop' : 'Play'}</span>
            </button>

            {!isPlaying && (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1 lg:gap-2 bg-blue-600 text-white px-2 lg:px-4 py-2 rounded hover:bg-blue-700 transition-colors text-xs lg:text-sm"
                  title="Save"
                  aria-label="Save"
                >
                  <Save size={14} />
                  <span className="hidden sm:inline">Save</span>
                </button>

                <button
                  onClick={handleShowProjects}
                  className="flex items-center gap-1 lg:gap-2 bg-gray-700 text-white px-2 lg:px-4 py-2 rounded hover:bg-gray-600 transition-colors text-xs lg:text-sm"
                  title="Open projects"
                  aria-label="Projects"
                >
                  <FolderOpen size={14} />
                  <span className="hidden sm:inline">Projects</span>
                </button>

                <select
                  aria-label="Export format"
                  title="Export format"
                  value={exportFormat}
                  onChange={event => setExportFormat(event.target.value as ExportFormat)}
                  className="min-w-0 max-w-24 bg-gray-700 text-white rounded px-1 text-xs"
                >
                  <option value="html">HTML</option>
                  <option value="react">React</option>
                  <option value="wordpress">WordPress</option>
                </select>
                <button
                  onClick={handleExport}
                  aria-busy={exporting}
                  className={`flex items-center gap-1 lg:gap-2 bg-slate-600 text-white px-2 lg:px-4 py-2 rounded hover:bg-slate-700 transition-colors text-xs lg:text-sm ${exporting ? 'opacity-60' : ''}`}
                  title="Export"
                  aria-label="Export"
                >
                  <Download size={14} />
                  <span className="hidden sm:inline">Export</span>
                </button>

                <button
                  onClick={() => setOptionsOpen(true)}
                  aria-label="Options"
                  title="Options"
                  className="flex items-center gap-1 bg-gray-700 text-white px-2 lg:px-4 py-2 rounded hover:bg-gray-600"
                >
                  <Settings size={14} /><span className="hidden sm:inline">Options</span>
                </button>
                <button
                  onClick={() => { setPanelOpen(!panelOpen); setSidebarOpen(false); }}
                  className="lg:hidden flex items-center gap-1 bg-gray-700 text-white px-2 py-2 rounded hover:bg-gray-600 transition-colors"
                  title="Toggle panel"
                  aria-label="Toggle panel"
                  aria-expanded={panelOpen}
                >
                  <PanelRightOpen size={14} />
                </button>
              </>
            )}
          </div>
          {projects !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div role="dialog" aria-modal="true" aria-labelledby="projects-title" className="w-full max-w-lg rounded bg-gray-800 p-4 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h2 id="projects-title" className="text-lg font-bold">Projects</h2>
                  <button onClick={() => setProjects(null)} aria-label="Close projects"><X size={20} /></button>
                </div>
                <form className="mb-4 flex gap-2" onSubmit={event => { event.preventDefault(); void handleCreateProject(); }}>
                  <input aria-label="New project name" value={newProjectName} onChange={event => setNewProjectName(event.target.value)}
                    maxLength={100} placeholder="New project name" className="min-w-0 flex-1 rounded bg-gray-700 p-2" />
                  <button type="submit" className="rounded bg-blue-600 px-3 py-2">New project</button>
                </form>
                <div className="max-h-96 overflow-y-auto space-y-2">
                  {projects.length === 0 && <p className="text-gray-400">No saved projects.</p>}
                  {projects.map((project) => (
                    <div key={project.id} className="flex items-center gap-2 rounded bg-gray-700 p-2">
                      <button className="flex-1 text-left truncate hover:text-blue-300" onClick={() => handleOpenProject(project)}>
                        {project.name}
                      </button>
                      <button className="p-2 hover:text-red-400" onClick={() => handleDeleteProject(project)} aria-label={`Delete ${project.name}`}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {optionsOpen && <Options onClose={() => setOptionsOpen(false)} />}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar - hidden during play mode */}
        {!isPlaying && (
          <>
            <div
              className={`
                editor-scrollbar absolute top-14 bottom-0 left-0 lg:top-auto lg:bottom-auto lg:relative z-40 lg:h-full lg:shrink-0 bg-gray-800 border-r border-gray-700 overflow-y-auto
                transition-all duration-300
                ${sidebarOpen ? 'w-72 translate-x-0' : 'w-0 -translate-x-full lg:translate-x-0 lg:w-72'}
              `}
            >
              <Sidebar />
            </div>

            {/* Overlay for mobile when sidebar is open */}
            {sidebarOpen && (
              <div
                className="lg:hidden absolute inset-x-0 top-14 bottom-0 bg-black bg-opacity-50 z-30"
                onClick={() => setSidebarOpen(false)}
              />
            )}
          </>
        )}

        {/* Viewport */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1">
            <Viewport exporting={exporting} />
            {!isPlaying && <SceneObjectsList />}
          </div>
        </div>

        {/* Right Panel - hidden during play mode */}
        {!isPlaying && (
          <>
            <div
              className={`
                editor-scrollbar absolute top-14 bottom-0 right-0 lg:top-auto lg:bottom-auto lg:right-auto lg:relative z-40 lg:h-full lg:shrink-0 bg-gray-800 border-l border-gray-700 overflow-y-auto
                transition-all duration-300
                ${panelOpen ? 'w-64 sm:w-80 translate-x-0' : 'w-0 translate-x-full lg:translate-x-0 lg:w-[22rem] xl:w-96'}
              `}
            >
              <div className="flex flex-col h-full">
                <Properties />
                <AssetPanel />
                <SceneOptions />
              </div>
            </div>

            {/* Overlay for mobile when panel is open */}
            {panelOpen && (
              <div
                className="lg:hidden absolute inset-x-0 top-14 bottom-0 bg-black bg-opacity-50 z-30"
                onClick={() => setPanelOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
