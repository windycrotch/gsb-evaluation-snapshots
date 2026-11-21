import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FileCode, FolderOpen, Package, Save } from 'lucide-react';
import { exportSettingsFromText, exportSettingsToText, loadExportSettings, rememberExportSettings } from '@/core/export/settings';
import type { ExportSettings } from '@/core/export/settings';
import { useProject } from '@/store/doc';
import { noteExport } from '@/store/learn';
import { downloadBlob } from '@/store/project';
import { toast, uiStore } from '@/store/ui';
import { skeletonCount, skeletonList } from '@/core/skeletons';
import { engineNeeds } from '@/core/export/engineNeeds';
import { buildAllSkeletonsExport, buildSpineExport } from './exportSpine';
import type { ExportResult } from './exportSpine';
import { Button, Dialog, SelectField, Toggle } from './ui/controls';
import { Segmented } from './ui/Segmented';
import { ExportAnimation } from './ExportAnimation';

export function ExportDialog() {
  const project = useProject();
  const [which, setWhich] = useState<string>('edited'); // 'edited', 'all', or the index of a skeleton
  const skeletons = skeletonList(project);
  const many = skeletonCount(project) > 1;
  const all = many && which === 'all';
  const picked = many && /^\d+$/.test(which) ? Math.min(Number(which), skeletons.length - 1) : undefined;
  const doc = picked !== undefined ? skeletons[picked] : project.skeleton;
  const [settings, setSettings] = useState<ExportSettings>(loadExportSettings);
  const {
    format,
    scale,
    maxSize,
    padding,
    pretty,
    nonessential,
    pot,
    includePreview,
    trim,
    rotate,
    filter,
    mixes,
    pma,
    square,
    alias,
    multipleOf4,
    cleanUp,
    splitColor,
    atlasPerSkin,
  } = settings;
  const change = (patch: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const [excluded, setExcluded] = useState<string[]>([]);
  const [tab, setTab] = useState<'data' | 'animation'>('data');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => rememberExportSettings(settings), [settings]);

  useEffect(() => {
    let alive = true;
    if (tab !== 'data') return;
    setBusy(true);
    setError(null);
    (all ? buildAllSkeletonsExport : buildSpineExport)({
      format,
      scale,
      maxSize,
      padding,
      pretty,
      nonessential,
      pot,
      includePreview,
      trim,
      rotate,
      filter,
      pma,
      square,
      alias,
      multipleOf4,
      cleanUp,
      splitColor,
      atlasPerSkin,
      includeMixes: mixes,
      excludeAnimations: excluded,
      skeletonIndex: picked,
    })
      .then((r) => alive && setResult(r))
      .catch((e: Error) => alive && (setError(e.message), setResult(null)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [
    format,
    scale,
    maxSize,
    padding,
    pretty,
    nonessential,
    pot,
    includePreview,
    trim,
    rotate,
    filter,
    pma,
    square,
    alias,
    multipleOf4,
    cleanUp,
    splitColor,
    atlasPerSkin,
    mixes,
    excluded,
    tab,
    all,
    picked,
  ]);

  /** One HTML file with the skeleton, the pictures and a player in it: opens offline, for sending to a client. */
  const savePlayer = async () => {
    try {
      const { buildPlayerPage } = await import('./exportPlayer');
      const page = buildPlayerPage(doc, { smooth: filter !== 'Nearest' });
      downloadBlob(new Blob([page.html], { type: 'text/html' }), `${base}-player.html`);
      noteExport('player');
      toast(
        page.missing.length
          ? `Player page saved, but these pictures are missing: ${page.missing.join(', ')}`
          : `Player page saved (${(page.bytes / 1024 / 1024).toFixed(1)} MB)`,
        page.missing.length ? 'info' : 'ok',
        page.missing.length ? 7000 : undefined,
      );
    } catch (e) {
      toast(`Could not make the player page: ${(e as Error).message}`, 'error');
    }
  };

  const needs = engineNeeds(doc, { format, scale, pma, rotate, filter, atlasPerSkin });
  const close = () => uiStore.patch({ exportOpen: false });
  const base = (all ? project.name || 'project' : doc.name || 'skeleton').replace(/[^\w-]+/g, '_');

  const saveSettings = () => {
    downloadBlob(new Blob([exportSettingsToText(settings)], { type: 'application/json' }), 'bone2d-export-settings.json');
    toast('Export settings saved', 'ok');
  };
  const copySettings = () => {
    navigator.clipboard.writeText(exportSettingsToText(settings)).then(
      () => toast('Export settings copied', 'ok'),
      () => toast('Could not copy: the browser blocked the clipboard', 'error'),
    );
  };
  const loadSettings = async (file: File | undefined) => {
    if (!file) return;
    const loaded = exportSettingsFromText(await file.text());
    if (!loaded) {
      toast('That file is not a Bone 2D export settings file', 'error');
      return;
    }
    setSettings(loaded);
    toast('Export settings loaded', 'ok');
  };

  return (
    <Dialog
      title="Export"
      width={tab === 'animation' ? 640 : undefined}
      onClose={close}
      footer={
        <>
          <Button ghost onClick={close}>
            Close
          </Button>
          {tab === 'data' && (
            <Button
              ghost
              icon={FileCode}
              disabled={busy}
              onClick={() => void savePlayer()}
              title="One HTML file with the skeleton, its pictures and a player: opens offline, nothing to install. For sending to a client"
            >
              Save player page
            </Button>
          )}
          {tab === 'data' && (
            <Button
              primary
              icon={Download}
              disabled={!result || busy}
              onClick={() => {
                if (!result) return;
                downloadBlob(new Blob([result.zip as BlobPart], { type: 'application/zip' }), `${base}-spine-4.3.zip`);
                noteExport('zip');
                toast('Export downloaded', 'ok');
              }}
            >
              Download ZIP
            </Button>
          )}
        </>
      }
    >
      <Segmented
        label="Export"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'data',
            label: 'Spine 4.3 data',
            tone: 'plain',
            title: 'Skeleton data (JSON or binary), texture atlas and a preview page',
          },
          { value: 'animation', label: 'Animation (GIF / PNG / video)', tone: 'plain', title: 'Render an animation to pictures' },
        ]}
      />
      {tab === 'animation' ? (
        <ExportAnimation />
      ) : (
        <>
          <p className="hint-text flush">
            Produces <b>{format === 'binary' ? '.skel' : '.json'} + .atlas + .png</b> that load in the official Spine 4.3 runtimes
            (spine-ts, Unity, Godot, Pixi, Phaser…).
          </p>
          <div className="section-label">Skeleton data</div>
          <div className="kv">
            {many && (
              <>
                <label>Skeleton</label>
                <SelectField
                  name="Skeleton"
                  value={which}
                  options={[
                    { value: 'edited', label: `The edited one (${project.skeleton.name})` },
                    ...skeletons.map((s, i) => ({ value: String(i), label: s.name })),
                    { value: 'all', label: 'All skeletons (a folder each)' },
                  ]}
                  onChange={setWhich}
                />
              </>
            )}
            <label>Skeleton file</label>
            <SelectField
              name="Skeleton file"
              value={format}
              options={[
                { value: 'json', label: 'JSON (.json)' },
                { value: 'binary', label: 'Binary (.skel), smaller' },
              ]}
              onChange={(v) => change({ format: v })}
            />
            <label>Size</label>
            <SelectField
              name="Size"
              value={String(scale)}
              options={[
                { value: '1', label: '100% (as drawn)' },
                { value: '0.75', label: '75%' },
                { value: '0.5', label: '50%' },
                { value: '0.25', label: '25%' },
                { value: '2', label: '200%' },
              ]}
              onChange={(v) => change({ scale: +v })}
            />
            <label>Editor data</label>
            <Toggle on={nonessential} onChange={(v) => change({ nonessential: v })} title="Bone colors, fps, image path" />
            {format === 'json' && (
              <>
                <label>Pretty JSON</label>
                <Toggle on={pretty} onChange={(v) => change({ pretty: v })} title="Pretty JSON" />
              </>
            )}
            <label>Clean up animations</label>
            <Toggle
              on={cleanUp}
              onChange={(v) => change({ cleanUp: v })}
              title="Leave out the keys that change nothing (a key in the middle of a run of equal values). The project keeps them"
            />
            <label>Split colour keys</label>
            <Toggle
              on={splitColor}
              onChange={(v) => change({ splitColor: v })}
              title="A slot whose colour keys only change the alpha gets an alpha timeline, one that only changes the colour gets an rgb timeline (as Spine writes them; an animation that a slider plays keeps rgba); off, every colour key is an rgba one"
            />
            <label>Mix table</label>
            <Toggle
              on={mixes}
              onChange={(v) => change({ mixes: v })}
              title="Write the crossfade times between animations as a JSON file for the game (only when the mix table has any)"
            />
            <label>Preview page</label>
            <Toggle
              on={includePreview}
              onChange={(v) => change({ includePreview: v })}
              title="A page that plays the export with the official Spine player"
            />
          </div>
          {doc.animations.length > 0 && (
            <div className="anim-pick">
              <span className="section-label flush">Animations to export</span>
              {doc.animations.map((a) => (
                <label key={a.id} className="check">
                  <input
                    type="checkbox"
                    checked={!excluded.includes(a.id)}
                    onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== a.id) : [...excluded, a.id])}
                  />
                  <span>{a.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="section-label">Atlas</div>
          <div className="kv">
            <label>Atlas page size</label>
            <SelectField
              name="Atlas page size"
              value={String(maxSize)}
              options={['1024', '2048', '4096'].map((v) => ({ value: v, label: `${v} px` }))}
              onChange={(v) => change({ maxSize: +v })}
            />
            <label>Padding</label>
            <SelectField
              name="Padding"
              value={String(padding)}
              options={['0', '1', '2', '4'].map((v) => ({ value: v, label: `${v} px` }))}
              onChange={(v) => change({ padding: +v })}
            />
            <label>Texture filter</label>
            <SelectField
              name="Texture filter"
              value={filter}
              options={[
                { value: 'Linear', label: 'Smooth (Linear)' },
                { value: 'Nearest', label: 'Sharp pixels (Nearest)' },
              ]}
              onChange={(v) => change({ filter: v })}
            />
          </div>
          <details className="engine-needs mb">
            <summary title="Page shape and how pictures are packed: the defaults suit most games">
              <span className="section-label flush">Advanced atlas options</span>
            </summary>
            <div className="kv">
              <label>Strip whitespace</label>
              <Toggle
                on={trim}
                onChange={(v) => change({ trim: v })}
                title="Cut the empty border off every picture so the atlas is smaller. Pictures a mesh uses are left whole."
              />
              <label>Rotate pictures</label>
              <Toggle
                on={rotate}
                onChange={(v) => change({ rotate: v })}
                title="Turn a picture a quarter turn on the page when that saves room"
              />
              <label>Power-of-two pages</label>
              <Toggle on={pot} onChange={(v) => change({ pot: v })} title="Atlas page sizes are powers of two" />
              {!pot && (
                <>
                  <label>Multiples of four</label>
                  <Toggle
                    on={multipleOf4}
                    onChange={(v) => change({ multipleOf4: v })}
                    title="Page sizes divisible by four, for compressed texture formats"
                  />
                </>
              )}
              <label>Square pages</label>
              <Toggle on={square} onChange={(v) => change({ square: v })} title="Every atlas page is as wide as it is tall" />
              <label>Premultiplied alpha</label>
              <Toggle
                on={pma}
                onChange={(v) => change({ pma: v })}
                title="Write the pages with the colour multiplied by the alpha (the atlas says pma:true); the engine must blend that way"
              />
              <label>Alias identical pictures</label>
              <Toggle
                on={alias}
                onChange={(v) => change({ alias: v })}
                title="Pictures with exactly the same pixels take one place in the atlas"
              />
              <label>Atlas per skin</label>
              <Toggle
                on={atlasPerSkin}
                onChange={(v) => change({ atlasPerSkin: v })}
                title="One atlas for the default skin and one for each other skin (only the pictures the default skin does not use), so a game loads a skin's pictures when it needs them. Nothing changes for a skeleton with one skin"
              />
            </div>
          </details>
          <div className="hstack mb">
            <Button ghost icon={Save} onClick={saveSettings} title="Save these settings to a file to share with a team">
              Save settings
            </Button>
            <Button ghost icon={Copy} onClick={copySettings} title="Copy these settings as text to paste into a message">
              Copy settings
            </Button>
            <Button ghost icon={FolderOpen} onClick={() => fileRef.current?.click()} title="Load export settings from a file">
              Load settings
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => (void loadSettings(e.target.files?.[0]), (e.target.value = ''))}
            />
          </div>
          <details className="engine-needs">
            <summary title="What the game has to do for this export to look the same as in the editor">
              <span className="section-label flush">What the engine needs</span>{' '}
              <span className="chip">{needs.filter((n) => n.level === 'needs').length}</span>
            </summary>
            {needs.some((n) => n.level === 'needs') && <p className="hint-text flush">Features the engine has to support</p>}
            <ul>
              {needs
                .filter((n) => n.level === 'needs')
                .map((n) => (
                  <li key={n.id}>{n.text}</li>
                ))}
            </ul>
            <p className="hint-text flush">To match on the engine side</p>
            <ul>
              {needs
                .filter((n) => n.level === 'note')
                .map((n) => (
                  <li key={n.id}>{n.text}</li>
                ))}
            </ul>
          </details>
          <div className="card roomy">
            {busy && <span className="hint-text">Packing atlas…</span>}
            {error && <span className="danger-text">{error}</span>}
            {result && !busy && (
              <>
                <div className="hstack mb dim">
                  <Package size={15} />
                  {all
                    ? `${skeletons.length} skeletons · ${result.pages} atlas page${result.pages === 1 ? '' : 's'}`
                    : `${doc.bones.length} bones · ${doc.slots.length} slots · ${doc.animations.length} animations · ${result.pages} atlas page${result.pages === 1 ? '' : 's'}`}
                </div>
                {result.files.map((f) => (
                  <div key={f.name} className="spread dim">
                    <span>{f.name}</span>
                    <span className="muted">{(f.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))}
                {result.missing.length > 0 && <div className="danger-text mt">Missing images: {result.missing.join(', ')}</div>}
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
