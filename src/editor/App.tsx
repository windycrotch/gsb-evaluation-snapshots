import { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  Bone,
  BoxSelect,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  Package,
  Grid3x3,
  Bell,
  Search,
  Home,
  Layers,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FlipHorizontal2,
  GitBranch,
  RotateCcw,
  SlidersHorizontal,
  Image as ImageIcon,
  CircleHelp,
  GraduationCap,
  MessageSquareText,
  Link2,
  Map as MapIcon,
  Maximize,
  Play,
  Redo2,
  Route,
  Ruler,
  Magnet,
  Trash2,
  Save,
  Sparkles,
  Type,
  Undo2,
} from 'lucide-react';
import { decodeKey } from '@/core/keyrefs';
import { selectionBack, selectionForward, startSelectionHistory } from '@/store/selHistory';
import {
  clearSelection,
  copyKeys,
  flipViewport,
  deleteBones,
  deleteKeys,
  pasteKeys,
  sanitizeSelection,
  setMode,
  setTime,
  setTool,
} from '@/store/actions';
import { docStore, useProject } from '@/store/doc';
import { pickReviewFile } from '@/store/reviewActions';
import { LESSONS } from '@/core/lessons';
import { openLesson } from '@/store/learn';
import { newProject, openProjectFile, packageProject, restoreAutosave, saveProjectFile, startAutosave } from '@/store/project';
import { openAtlasUnpack, openSpineImport } from './importSpine';
import { deleteConstraint } from '@/store/ikActions';
import { loadSample } from '@/store/sample';
import { uiStore, useUi } from '@/store/ui';
import { useLang } from '@/i18n';
import { LangToggle } from './ui/LangToggle';
import { openDeepLink } from './deeplink';
import { startPlaybackLoop } from './playback';
import { AssetsPanel } from './panels/AssetsPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { TreePanel } from './panels/TreePanel';
import { Timeline } from './timeline/Timeline';
import { Button, Dialog, IconButton, Menu, MenuItem, Splitter } from './ui/controls';
import { Segmented } from './ui/Segmented';
import { TooltipHost } from './ui/Tooltip';
import { FloatingPanels } from './panels/FloatingPanels';
import { KeyDialogHost } from './timeline/KeyDialog';
import { AskHost } from './ui/AskHost';
import { MarkerDialogHost } from './timeline/MarkerDialog';
import { SliceDialogHost } from './panels/SliceDialog';
import { FLOAT_LIST, toggleFloat, useFloats } from '@/store/floats';
import { Viewport, viewportApi } from './viewport/Viewport';
import { ExportDialog } from './ExportDialog';
import { FeedbackDialog } from './Feedback';
import { UpdatesDialog, hasUnseenUpdate } from './Updates';
import { focusArea, setFocusArea } from './focus';
import { comboOf, hotkeyGroups, keyIdOf, KEYS, latinKey } from './hotkeys';
import { KEY_ACTIONS } from './keyActions';
import { HINTS, TOOLS, hotkeyOf, toolForKey } from './tools';
import { SettingsDialog } from './Settings';
import { LearnCard } from './LearnCard';
import { LessonsMenu } from './LessonsMenu';
import { WelcomeDialog } from './Welcome';
import { Palette } from './Palette';
import { settingsStore } from '@/store/settings';
import { cancelSetParent, startSetParent } from '@/store/parentActions';
import { copyPose, duplicateSelection, pastePose, resetPose, swapSides } from '@/store/poseActions';
import { clearGuides } from '@/store/guideActions';
import { isolateSelection, showAll } from '@/store/visibilityActions';
import { useSettings } from '@/store/settings';
import { AnimationsPanel } from './panels/AnimationsPanel';
import { SkinsPanel } from './panels/SkinsPanel';
import { AnimationToolsPanel } from './panels/AnimationToolsPanel';
import { PosesPanel } from './panels/PosesPanel';
import { PlaybackPanel } from './panels/PlaybackPanel';
import { MetricsPanel } from './panels/MetricsPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { CommentsPanel } from './panels/CommentsPanel';
import { LAYOUTS, VIEW_LIST, sameViews } from '@/store/layout';
import { applyLayout, startLayoutPersist, toggleAllViews, toggleView } from '@/store/viewActions';
import { microMove } from '@/store/nudgeActions';
import { applySavedLayout, deleteSavedLayout, saveLayoutDialog, useNamedLayouts } from '@/store/layoutActions';

function TopBar() {
  useSettings((s) => s.keyMap); // the combinations can be changed in Settings
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const view = useUi((s) => s.view);
  const views = useUi((s) => s.views);
  const savedLayouts = useNamedLayouts();
  const floats = useFloats((s) => s.open);
  const updatesOpen = useUi((s) => s.updatesOpen); // the dot goes out once the window has been opened
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = docStore.subscribe(() => force((n) => n + 1));
    return () => void unsub();
  }, []);

  return (
    <header className="topbar">
      <div className="brand" role="heading" aria-level={1}>
        <span className="brand-mark">
          <svg width="16" height="16" viewBox="0 0 32 32">
            <path d="M9 22 L16 10 L23 22" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="9" cy="22" r="2.6" fill="currentColor" />
            <circle cx="16" cy="10" r="2.6" fill="currentColor" />
            <circle cx="23" cy="22" r="2.6" fill="currentColor" />
          </svg>
        </span>
        Bone 2D
      </div>
      <input
        className="project-name"
        value={project.name}
        spellCheck={false}
        onChange={(e) => docStore.update('Rename project', (d) => void (d.name = e.target.value))}
        aria-label="Project name"
        data-tip="Project name"
      />
      {docStore.dirty && <span className="dirty-dot" role="status" aria-label="Unsaved changes" data-tip="Unsaved changes" />}
      <Menu label="File">
        {(close) => (
          <>
            <MenuItem icon={FilePlus2} close={close} onClick={() => newProject()}>
              New project
            </MenuItem>
            <MenuItem icon={FolderOpen} close={close} hotkey={KEYS.open} onClick={() => openProjectFile()}>
              Open…
            </MenuItem>
            <MenuItem icon={Save} close={close} hotkey={KEYS.save} onClick={() => saveProjectFile()}>
              Save
            </MenuItem>
            <MenuItem icon={Save} close={close} hotkey={KEYS.saveAs} onClick={() => saveProjectFile(true)}>
              Save as…
            </MenuItem>
            <MenuItem icon={Package} close={close} onClick={() => void packageProject()}>
              Package project (ZIP)…
            </MenuItem>
            <MenuItem icon={MessageSquareText} close={close} onClick={() => pickReviewFile()}>
              Import review comments…
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={Download} close={close} hotkey={KEYS.export} onClick={() => uiStore.patch({ exportOpen: true })}>
              Export for Spine 4.3…
            </MenuItem>
            <MenuItem icon={FolderOpen} close={close} onClick={() => openSpineImport()}>
              Import Spine data (JSON 4.0–4.3, binary 4.3)…
            </MenuItem>
            <MenuItem icon={FolderOpen} close={close} onClick={() => openSpineImport(true)}>
              Import Spine data as a new skeleton…
            </MenuItem>
            <MenuItem icon={FolderOpen} close={close} onClick={() => openAtlasUnpack()}>
              Unpack an atlas into pictures…
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={Sparkles} close={close} onClick={() => loadSample()}>
              Load demo rig (Kit)
            </MenuItem>
            <MenuItem icon={Home} close={close} onClick={() => uiStore.patch({ welcomeOpen: true })}>
              Welcome screen
            </MenuItem>
          </>
        )}
      </Menu>
      <Menu label="Edit">
        {(close) => (
          <>
            <MenuItem icon={Undo2} close={close} hotkey={KEYS.undo} disabled={!docStore.canUndo} onClick={() => docStore.undo()}>
              Undo
            </MenuItem>
            <MenuItem icon={Redo2} close={close} hotkey={KEYS.redo} disabled={!docStore.canRedo} onClick={() => docStore.redo()}>
              Redo
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem
              icon={Copy}
              close={close}
              hotkey={KEYS.duplicate}
              disabled={mode !== 'setup'}
              onClick={() => duplicateSelection(false)}
            >
              Duplicate bones
            </MenuItem>
            <MenuItem
              icon={FlipHorizontal2}
              close={close}
              hotkey={KEYS.mirror}
              disabled={mode !== 'setup'}
              onClick={() => duplicateSelection(true)}
            >
              Mirror bones
            </MenuItem>
            <MenuItem icon={GitBranch} close={close} hotkey={KEYS.parent} disabled={mode !== 'setup'} onClick={() => startSetParent()}>
              Set parent
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={Eye} close={close} hotkey={KEYS.showAll} onClick={() => showAll()}>
              Show everything hidden
            </MenuItem>
            <MenuItem icon={EyeOff} close={close} hotkey={KEYS.isolate} onClick={() => isolateSelection()}>
              Show only the selection
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={RotateCcw} close={close} disabled={mode !== 'animate'} onClick={() => resetPose()}>
              Reset pose
            </MenuItem>
            <MenuItem icon={ClipboardCopy} close={close} onClick={() => copyPose()}>
              Copy pose
            </MenuItem>
            <MenuItem icon={ClipboardPaste} close={close} onClick={() => pastePose()}>
              Paste pose
            </MenuItem>
            <MenuItem icon={ArrowLeftRight} close={close} onClick={() => swapSides()}>
              Swap left and right pose
            </MenuItem>
          </>
        )}
      </Menu>
      <Menu label="Windows">
        {(close) => (
          <>
            {VIEW_LIST.map((v) => (
              <MenuItem key={v.id} close={close} checked={views[v.id]} onClick={() => toggleView(v.id)}>
                {v.label}
              </MenuItem>
            ))}
            <div className="menu-sep" />
            {FLOAT_LIST.map((w) => (
              <MenuItem key={w.id} close={close} checked={floats[w.id]} onClick={() => toggleFloat(w.id)}>
                {`Floating: ${w.label}`}
              </MenuItem>
            ))}
            <div className="menu-sep" />
            {LAYOUTS.map((l) => (
              <MenuItem key={l.id} close={close} checked={sameViews(views, l.views)} onClick={() => applyLayout(l.id)}>
                {`Layout: ${l.label}`}
              </MenuItem>
            ))}
            {savedLayouts.map((l) => (
              <div key={l.id} className="menu-row">
                <MenuItem close={close} checked={sameViews(views, l.views)} onClick={() => applySavedLayout(l.id)}>
                  {`Layout: ${l.name}`}
                </MenuItem>
                <IconButton icon={Trash2} title="Delete this saved layout" small onClick={() => deleteSavedLayout(l.id)} />
              </div>
            ))}
            <MenuItem close={close} icon={Save} onClick={() => void saveLayoutDialog()}>
              Save layout as…
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem close={close} hotkey={KEYS.hideViews} onClick={() => toggleAllViews()}>
              Hide / show all windows
            </MenuItem>
          </>
        )}
      </Menu>
      <Menu label="View">
        {(close) => (
          <>
            <MenuItem
              close={close}
              icon={Grid3x3}
              checked={view.grid}
              onClick={() => uiStore.patch({ view: { ...view, grid: !view.grid } })}
            >
              Grid
            </MenuItem>
            <MenuItem
              close={close}
              icon={Type}
              checked={view.names}
              onClick={() => uiStore.patch({ view: { ...view, names: !view.names } })}
            >
              Bone names
            </MenuItem>
            <MenuItem
              close={close}
              icon={ImageIcon}
              checked={view.images}
              onClick={() => uiStore.patch({ view: { ...view, images: !view.images } })}
            >
              Images
            </MenuItem>
            <MenuItem
              close={close}
              icon={Bone}
              checked={view.bones}
              onClick={() => uiStore.patch({ view: { ...view, bones: !view.bones } })}
            >
              Bones
            </MenuItem>
            <MenuItem
              close={close}
              icon={Link2}
              checked={view.constraints}
              onClick={() => uiStore.patch({ view: { ...view, constraints: !view.constraints } })}
            >
              Constraints
            </MenuItem>
            <MenuItem
              close={close}
              icon={Route}
              checked={view.constraintInfo}
              onClick={() => uiStore.patch({ view: { ...view, constraintInfo: !view.constraintInfo } })}
            >
              Constraint arrows
            </MenuItem>
            <MenuItem
              close={close}
              icon={BoxSelect}
              checked={view.outlines}
              onClick={() => uiStore.patch({ view: { ...view, outlines: !view.outlines } })}
            >
              Clips, boxes &amp; points
            </MenuItem>
            <MenuItem
              close={close}
              icon={Layers}
              checked={view.onion}
              onClick={() => uiStore.patch({ view: { ...view, onion: !view.onion } })}
            >
              Onion skin
            </MenuItem>
            <MenuItem
              close={close}
              icon={Ruler}
              checked={view.rulers}
              onClick={() => uiStore.patch({ view: { ...view, rulers: !view.rulers } })}
            >
              Rulers and guides
            </MenuItem>
            <MenuItem
              close={close}
              icon={Magnet}
              checked={view.snap}
              onClick={() => uiStore.patch({ view: { ...view, snap: !view.snap } })}
            >
              Snap to grid and guides
            </MenuItem>
            <MenuItem
              close={close}
              icon={Magnet}
              checked={view.pixel}
              onClick={() => uiStore.patch({ view: { ...view, pixel: !view.pixel } })}
            >
              Snap to whole pixels
            </MenuItem>
            <MenuItem
              close={close}
              icon={MapIcon}
              checked={view.outline}
              onClick={() => uiStore.patch({ view: { ...view, outline: !view.outline } })}
            >
              Outline map
            </MenuItem>
            <MenuItem close={close} icon={Trash2} onClick={() => void clearGuides()}>
              Clear guides
            </MenuItem>
            <MenuItem
              close={close}
              icon={Route}
              checked={view.trails}
              onClick={() => uiStore.patch({ view: { ...view, trails: !view.trails } })}
            >
              Motion trails
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem close={close} icon={Maximize} hotkey={KEYS.frame} onClick={() => viewportApi.frame()}>
              Frame skeleton
            </MenuItem>
            <MenuItem close={close} icon={Maximize} hotkey={KEYS.frameSelection} onClick={() => viewportApi.frameSelection()}>
              Frame the selection
            </MenuItem>
            <MenuItem close={close} icon={Maximize} hotkey={KEYS.zoom100} onClick={() => viewportApi.zoom100()}>
              Zoom to 100%
            </MenuItem>
            <MenuItem close={close} icon={FlipHorizontal2} hotkey={KEYS.flipView} onClick={() => flipViewport()}>
              Flip the viewport
            </MenuItem>
          </>
        )}
      </Menu>
      <span className="spacer" />
      <Segmented
        label="Mode"
        learn="mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'setup', label: 'Setup', icon: Bone, tone: 'setup', title: 'Setup: build the rig (Tab)' },
          { value: 'animate', label: 'Animate', icon: Play, tone: 'animate', title: 'Animate: pose and key (Tab)' },
        ]}
      />
      <span className="spacer" />
      <IconButton
        icon={Undo2}
        title={docStore.undoLabel ? `Undo ${docStore.undoLabel}` : 'Undo'}
        hotkey={KEYS.undo}
        disabled={!docStore.canUndo}
        onClick={() => docStore.undo()}
      />
      <IconButton icon={Redo2} title="Redo" hotkey={KEYS.redo} disabled={!docStore.canRedo} onClick={() => docStore.redo()} />
      <span className="sep" />
      <LangToggle />
      <span className="tb-opt2">
        <IconButton
          icon={Search}
          title="Command palette: find any command or tool by name"
          hotkey={KEYS.palette}
          onClick={() => uiStore.patch({ paletteOpen: true })}
        />
      </span>
      <span className="tb-opt">
        <span className="badge-wrap">
          <IconButton
            icon={Bell}
            title="Updates: what is new and the project activity"
            onClick={() => uiStore.patch({ updatesOpen: true })}
          />
          {hasUnseenUpdate() && !updatesOpen && <span className="notify-dot" role="status" aria-label="New updates" />}
        </span>
      </span>
      <IconButton icon={SlidersHorizontal} title="Settings" hotkey={KEYS.settings} onClick={() => uiStore.patch({ settingsOpen: true })} />
      <span className="tb-opt">
        <IconButton icon={MessageSquareText} title="Send feedback to the author" onClick={() => uiStore.patch({ feedbackOpen: true })} />
        <IconButton icon={CircleHelp} title="Shortcuts & help" hotkey={KEYS.help} onClick={() => uiStore.patch({ helpOpen: true })} />
      </span>
      <LessonsMenu />
      <Button primary icon={Download} learn="export" onClick={() => uiStore.patch({ exportOpen: true })}>
        Export
      </Button>
    </header>
  );
}

function Toolbox() {
  useSettings((s) => s.toolKeys); // the letters can be changed in Settings
  const tool = useUi((s) => s.tool);
  const mode = useUi((s) => s.mode);
  return (
    <div className="toolbox">
      {TOOLS.map((t) => (
        <IconButton
          key={t.tool}
          icon={t.icon}
          title={t.title}
          hotkey={hotkeyOf(t.tool)}
          tipPlace="right"
          learn={`tool-${t.tool}`}
          active={tool === t.tool}
          animate={mode === 'animate'}
          disabled={!!t.setupOnly && mode !== 'setup'}
          onClick={() => setTool(t.tool)}
        />
      ))}
    </div>
  );
}

function ViewportHud() {
  useSettings((s) => s.keyMap);
  const tool = useUi((s) => s.tool);
  const pickParent = useUi((s) => s.pickParent);
  const mode = useUi((s) => s.mode);
  const zoom = useUi((s) => s.camera.zoom);
  const project = useProject();
  const view = useUi((s) => s.view);
  const empty = project.skeleton.bones.length <= 1 && project.skeleton.slots.length === 0;
  return (
    <>
      <div className={`vp-border${mode === 'animate' ? ' animate' : ''}`} />
      <Toolbox />
      <div className="vp-top-right">
        <span className="chip plain">{Math.round(zoom * 100)}%</span>
        <IconButton icon={Maximize} title="Frame skeleton" hotkey={KEYS.frame} small onClick={() => viewportApi.frame()} />
        <IconButton
          icon={Layers}
          title="Onion skin: faded poses of the frames around the playhead (Animate mode)"
          small
          active={view.onion}
          onClick={() => uiStore.patch({ view: { ...uiStore.get().view, onion: !uiStore.get().view.onion } })}
        />
        <IconButton
          icon={Route}
          title="Motion trails: the path the selected bones travel in the animation, keys marked (Animate mode)"
          small
          active={view.trails}
          onClick={() => uiStore.patch({ view: { ...uiStore.get().view, trails: !uiStore.get().view.trails } })}
        />
        <IconButton
          icon={Ruler}
          title="Rulers and guides: drag a guide out of a ruler"
          small
          active={view.rulers}
          onClick={() => uiStore.patch({ view: { ...uiStore.get().view, rulers: !uiStore.get().view.rulers } })}
        />
        <IconButton
          icon={Magnet}
          title="Snap new and moved bones to the grid and the guides"
          small
          active={view.snap}
          onClick={() => uiStore.patch({ view: { ...uiStore.get().view, snap: !uiStore.get().view.snap } })}
        />
        <IconButton
          icon={Eye}
          title="Toggle names"
          small
          onClick={() => uiStore.patch({ view: { ...uiStore.get().view, names: !uiStore.get().view.names } })}
        />
      </div>
      {empty && (
        <div className="vp-empty">
          <div className="vp-empty-card">
            <b>Start rigging</b>
            Drop PNG images here, then press <span className="kbd">B</span> and drag to draw bones.
            <div style={{ margin: '14px 0 4px' }}>
              <Button primary icon={Sparkles} onClick={() => loadSample()}>
                Load the demo rig
              </Button>
            </div>
            <span className="hint-text">a finished character with IK legs and a walk cycle</span>
            <div style={{ margin: '12px 0 0' }}>
              <Button icon={GraduationCap} onClick={() => void openLesson('fox')}>
                Take the 2-minute tutorial
              </Button>
            </div>
          </div>
        </div>
      )}
      {pickParent ? (
        <div className="vp-hint">Click the new parent bone in the viewport or the tree · Esc cancels</div>
      ) : (
        HINTS[tool] && (
          <div key={tool} className="vp-hint">
            {HINTS[tool]}
          </div>
        )
      )}
    </>
  );
}

/** A combination such as "Ctrl+Shift+Z" as key caps. */
function Keys({ combo }: { combo: string }) {
  return (
    <>
      {combo.split('+').map((k, i) => (
        <kbd key={i} className="kbd">
          {k}
        </kbd>
      ))}
    </>
  );
}

function HelpDialog() {
  const lang = useLang();
  useSettings((s) => s.toolKeys);
  useSettings((s) => s.keyMap);
  return (
    <Dialog title="Bone 2D — shortcuts" onClose={() => uiStore.patch({ helpOpen: false })} width={720}>
      <p className="hint-text flush mb">
        Bone 2D is a browser-based 2D skeletal animation editor. Build a rig in <b>Setup</b>, pose and key it in <b>Animate</b>, then export
        a Spine 4.3 compatible skeleton + atlas.
      </p>
      <h3 className="section-label">Lessons</h3>
      <div className="hstack wrap mb">
        {LESSONS.map((lesson) => (
          <Button
            key={lesson.id}
            icon={GraduationCap}
            learn={`lesson-${lesson.id}`}
            onClick={() => {
              uiStore.patch({ helpOpen: false });
              void openLesson(lesson.id);
            }}
          >
            {lesson.title[lang]}
          </Button>
        ))}
      </div>
      <div className="hotkeys">
        {hotkeyGroups().map((g) => (
          <section key={g.title} className="hk-group">
            <h3 className="section-label">{g.title}</h3>
            {g.rows.map((r) => (
              <div key={r.label} className="hk-row">
                <span>{r.label}</span>
                <span className="hk-keys">
                  {r.keys.map((combo, i) => (
                    <span key={combo} className="hk-combo">
                      {i > 0 && <span className="muted">/</span>}
                      <Keys combo={combo} />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function Toast() {
  const t = useUi((s) => s.toast);
  if (!t) return null;
  return (
    <div className={`toast ${t.kind}`} role="status">
      {t.text}
    </div>
  );
}

export function App() {
  const panel = useUi((s) => s.panel);
  const views = useUi((s) => s.views);
  const exportOpen = useUi((s) => s.exportOpen);
  const helpOpen = useUi((s) => s.helpOpen);
  const updatesOpen = useUi((s) => s.updatesOpen);
  const feedbackOpen = useUi((s) => s.feedbackOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const welcomeOpen = useUi((s) => s.welcomeOpen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  useLang(); // the whole tree re-renders when the language changes: strings are translated while rendering

  useEffect(() => {
    const stopPlayback = startPlaybackLoop();
    const stopAutosave = startAutosave();
    const stopLayout = startLayoutPersist();
    const stopSanitize = docStore.subscribe(sanitizeSelection); // undo / redo can remove what is selected
    const stopSelHistory = startSelectionHistory();
    void openDeepLink(window.location.search)
      .then((opened) => opened || restoreAutosave())
      .then((ok) => {
        if (!ok) {
          setTimeout(() => viewportApi.frame(), 60);
          if (settingsStore.get().showWelcome) uiStore.patch({ welcomeOpen: true });
        }
      });
    const warn = (e: BeforeUnloadEvent) => {
      if (docStore.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const ui = uiStore.get();
      const key = latinKey(e).toLowerCase();
      if (el?.closest?.('[role=menu]')) return; // the keys of a menu belong to the menu
      // a control that the keyboard has focused keeps Tab, Space and Enter (a click leaves no focus ring, so after a click Space still plays)
      if (key === 'tab' || key === ' ' || key === 'enter') {
        if (el?.closest?.('button, a, [role=menuitem], [role=radio], [role=switch]') && el.matches(':focus-visible')) return;
      }
      // the commands whose combination can be moved in Settings (hotkeys.ts); what each does is in keyActions.ts
      const combo = comboOf(e);
      const bound = combo ? keyIdOf(combo) : null;
      const action = bound ? KEY_ACTIONS[bound] : undefined;
      if (action) {
        action(e);
        return;
      }
      if (ctrl) {
        if (key === 'c' && ui.selectedKeys.length) {
          e.preventDefault();
          copyKeys(ui.selectedKeys.map(decodeKey));
        } else if (key === 'v' && ui.mode === 'animate') {
          e.preventDefault();
          const refs = pasteKeys(ui.time, e.shiftKey); // Ctrl+Shift+V: Paste Keys - Hold
          if (refs.length)
            uiStore.patch({
              selectedKeys: refs.map((r) => JSON.stringify([r.kind, r.target, r.prop, Math.round(r.time * 10000) / 10000])),
            });
        }
        return;
      }
      // micro-move: Alt + arrows nudge the selected bones, or the selected keys of the timeline (Shift: ten steps)
      if (e.altKey && (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown')) {
        e.preventDefault();
        microMove(key, e.shiftKey, focusArea() === 'timeline');
        return;
      }
      const tool = toolForKey(key);
      if (tool) {
        setTool(tool);
        return;
      }
      switch (key) {
        case 'enter':
          if (viewportApi.controller?.polygonTool.commit() || viewportApi.controller?.pathTool.commit()) e.preventDefault();
          break;
        case 'arrowleft':
        case 'arrowright':
          if (ui.mode === 'animate') {
            e.preventDefault();
            const fps = docStore.get().skeleton.fps;
            uiStore.patch({ playing: false });
            setTime(ui.time + ((key === 'arrowright' ? 1 : -1) * (e.shiftKey ? 10 : 1)) / fps);
          }
          break;
        case 'home':
          if (ui.mode === 'animate') setTime(0);
          break;
        case 'pageup':
          e.preventDefault();
          selectionBack();
          break;
        case 'pagedown':
          e.preventDefault();
          selectionForward();
          break;
        case 'delete':
        case 'backspace':
          if (focusArea() === 'timeline' && ui.selectedKeys.length) {
            e.preventDefault();
            deleteKeys(ui.selectedKeys.map(decodeKey));
            uiStore.patch({ selectedKeys: [] });
          } else if (
            ui.tool === 'mesh' &&
            ui.selection.vertices.length &&
            (viewportApi.controller?.pathTool.deleteSelectedVertices() ||
              viewportApi.controller?.polygonTool.deleteSelectedVertices() ||
              viewportApi.controller?.meshTool.deleteSelectedVertices())
          ) {
            e.preventDefault();
          } else if (ui.selection.constraint && !ui.selection.bones.length) {
            e.preventDefault();
            deleteConstraint(ui.selection.constraint);
          } else if (ui.selection.bones.length) {
            e.preventDefault();
            deleteBones(ui.selection.bones);
          }
          break;
        case 'escape':
          if (cancelSetParent()) break;
          if (viewportApi.controller?.polygonTool.cancel() || viewportApi.controller?.pathTool.cancel()) break; // an unfinished polygon or path is dropped first
          clearSelection();
          uiStore.patch({ selectedKeys: [] });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stopPlayback();
      stopAutosave();
      stopLayout();
      void stopSanitize();
      stopSelHistory();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  useEffect(() => {
    const onErr = (e: ErrorEvent) => console.error(e.error ?? e.message);
    window.addEventListener('error', onErr);
    return () => window.removeEventListener('error', onErr);
  }, []);

  const drag = (key: 'left' | 'right' | 'bottom', sign: 1 | -1, min: number, max: number) => (d: number) => {
    const p = uiStore.get().panel;
    uiStore.patch({ panel: { ...p, [key]: Math.min(max, Math.max(min, p[key] + sign * d)) } });
  };

  const leftOn =
    views.tree ||
    views.images ||
    views.animations ||
    views.skins ||
    views.playback ||
    views.tools ||
    views.poses ||
    views.metrics ||
    views.history ||
    views.preview;

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        {leftOn && (
          <>
            <aside
              className="left"
              aria-label="Hierarchy and images"
              style={{ width: panel.left }}
              onPointerDownCapture={() => setFocusArea('tree')}
            >
              {views.tree && <TreePanel />}
              {views.animations && <AnimationsPanel />}
              {views.skins && <SkinsPanel />}
              {views.playback && <PlaybackPanel />}
              {views.tools && <AnimationToolsPanel />}
              {views.poses && <PosesPanel />}
              {views.metrics && <MetricsPanel />}
              {views.history && <HistoryPanel />}
              {views.comments && <CommentsPanel />}
              {views.preview && <PreviewPanel />}
              {views.images && <AssetsPanel />}
            </aside>
            <Splitter dir="v" onDrag={drag('left', 1, 200, 480)} />
          </>
        )}
        <main className="center">
          <div className="viewport-wrap" onPointerDownCapture={() => setFocusArea('viewport')}>
            <Viewport />
            <ViewportHud />
            <LearnCard />
          </div>
          {views.timeline && (
            <>
              <Splitter dir="h" onDrag={drag('bottom', -1, 130, 620)} />
              <div onPointerDownCapture={() => setFocusArea('timeline')}>
                <Timeline />
              </div>
            </>
          )}
        </main>
        {views.inspector && (
          <>
            <Splitter dir="v" onDrag={drag('right', -1, 230, 480)} />
            <aside
              className="right"
              aria-label="Inspector"
              style={{ width: panel.right }}
              onPointerDownCapture={() => setFocusArea('viewport')}
            >
              <InspectorPanel />
            </aside>
          </>
        )}
      </div>
      {exportOpen && <ExportDialog />}
      {helpOpen && <HelpDialog />}
      {updatesOpen && <UpdatesDialog />}
      {feedbackOpen && <FeedbackDialog />}
      {settingsOpen && <SettingsDialog />}
      {welcomeOpen && <WelcomeDialog />}
      {paletteOpen && <Palette />}
      <FloatingPanels />
      <KeyDialogHost />
      <AskHost />
      <MarkerDialogHost />
      <SliceDialogHost />
      <Toast />
      <TooltipHost />
    </div>
  );
}
