import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Layers, Maximize2, Pause, Play, Plus, RotateCcw, Trash2, Volume2, VolumeX } from 'lucide-react';
import { GLRenderer } from '@/render/gl';
import type { EventDef, EventKey, Id } from '@/core/model';
import { PreviewPlayer, poseMixed } from '@/core/preview';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { Skeleton } from '@/core/skeleton';
import { assets } from '@/store/assets';
import { docStore, useProject } from '@/store/doc';
import { setDefaultMix, setMixPair } from '@/store/mixActions';
import { settingsStore } from '@/store/settings';
import { hasSound, pickSounds, playEventSound, soundCount } from '@/store/sounds';
import { toast, uiStore } from '@/store/ui';
import { Button, IconButton, NumberField, SelectField, Toggle } from '../ui/controls';
import { mirrorToPopout, openPopout } from '../popout';
import { Field } from '../ui/Field';

const SETUP = '';
const HEIGHT = 190;

/** One animation played over the main one. */
interface LayerCfg {
  animId: Id;
  alpha: number;
  additive: boolean;
  loop: boolean;
}

interface Fired {
  id: number;
  text: string;
  sound: boolean;
}

/**
 * The Preview window: a small view of its own that plays an animation the way a game would, with a crossfade when it changes to another
 * one (the mix table below), loop and speed, and the events with their sounds (load sound files with the speaker button).
 */
export function PreviewPanel() {
  const project = useProject();
  const doc = project.skeleton;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [player] = useState(() => new PreviewPlayer());
  const [animId, setAnimId] = useState<Id>(SETUP);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [hold, setHold] = useState(false);
  const [layers, setLayers] = useState<LayerCfg[]>([]);
  const [fired, setFired] = useState<Fired[]>([]);
  const [sounds, setSounds] = useState(soundCount());
  const [pairFrom, setPairFrom] = useState<Id>('');
  const [pairTo, setPairTo] = useState<Id>('');
  const fit = useRef(true);
  const cam = useRef({ x: 0, y: 0, zoom: 1 });
  const logId = useRef(0);

  const animations = doc.animations;
  const current = animations.find((a) => a.id === animId) ?? null;
  const mixes = project.mixes;

  // the animation that was chosen is gone: back to the setup pose
  useEffect(() => {
    if (animId !== SETUP && !current) setAnimId(SETUP);
  }, [animId, current]);

  const choose = (id: Id) => {
    setAnimId(id);
    player.play(animations.find((a) => a.id === id) ?? null, docStore.get().mixes);
    fit.current = true;
    setFired([]);
  };

  useEffect(() => {
    player.playing = playing;
    player.loop = loop;
    player.speed = speed;
    player.hold = hold;
  }, [player, playing, loop, speed, hold]);

  // the layers the player runs follow the ones set here (a layer keeps its time while it keeps its animation)
  useEffect(() => {
    player.layers = layers.map((c, i) => {
      const old = player.layers[i];
      const anim = animations.find((a) => a.id === c.animId) ?? null;
      return { anim, time: old && old.anim?.id === c.animId ? old.time : 0, alpha: c.alpha, additive: c.additive, loop: c.loop };
    });
  }, [player, layers, animations]);
  const setLayer = (i: number, patch: Partial<LayerCfg>) => setLayers((old) => old.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const restart = () => {
    choose(animId);
    for (const l of player.layers) l.time = 0;
  };

  useEffect(() => {
    const el = canvas.current!;
    let renderer: GLRenderer;
    try {
      renderer = new GLRenderer(el);
    } catch {
      return;
    }
    renderer.source = {
      get: (name) => {
        const a = assets.get(name);
        return a ? { bitmap: a.bitmap, version: a.version } : null;
      },
    };
    let sk: Skeleton | null = null;
    let scratch: Skeleton | null = null;
    let built: { doc: unknown; skin: Id | null } | null = null;
    let physicsReset = true;
    let raf = 0;
    let last = performance.now();

    const rebuild = () => {
      const p = docStore.get();
      const skin = uiStore.get().skinId;
      if (sk && built && built.doc === p.skeleton && built.skin === skin) return sk;
      const data = compileSkeleton(p.skeleton);
      const skinId = skin && p.skeleton.skins.some((s) => s.id === skin) ? skin : null;
      sk = createSkeleton(data, skinId);
      scratch = createSkeleton(data, skinId);
      built = { doc: p.skeleton, skin };
      physicsReset = true;
      return sk;
    };

    /** Camera over the skeleton as it moves through the whole animation. */
    const fitCamera = (s: Skeleton, w: number, h: number) => {
      const a = player.anim;
      let box: [number, number, number, number] | null = null;
      for (let i = 0; i <= 8; i++) {
        poseMixed(s, null, { anim: a, time: a ? (a.duration * i) / 8 : 0 }, 1);
        s.updateWorldTransform();
        const b = s.getBounds();
        if (!b) continue;
        box = box
          ? [
              Math.min(box[0], b[0]),
              Math.min(box[1], b[1]),
              Math.max(box[0] + box[2], b[0] + b[2]) - Math.min(box[0], b[0]),
              Math.max(box[1] + box[3], b[1] + b[3]) - Math.min(box[1], b[1]),
            ]
          : b;
      }
      if (!box) return;
      cam.current = {
        x: box[0] + box[2] / 2,
        y: box[1] + box[3] / 2,
        zoom: Math.min(4, (0.85 * w) / Math.max(box[2], 20), (0.85 * h) / Math.max(box[3], 20)),
      };
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = rebuild();
      const p = docStore.get();
      // the document may have replaced the animation (an edit): keep playing the same one at the same time
      const fresh = player.anim ? p.skeleton.animations.find((a) => a.id === player.anim!.id) : null;
      if (fresh) player.anim = fresh;
      const events = player.advance(dt);
      if (events.length) {
        const list: Fired[] = events.map((k: EventKey) => reportEvent(k, p.skeleton.events));
        setFired((old) => [...list.reverse(), ...old].slice(0, 6));
      }
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.max(1, Math.round(w * dpr));
        el.height = Math.max(1, Math.round(h * dpr));
      }
      if (fit.current) {
        fitCamera(s, w, h);
        fit.current = false;
      }
      player.pose(s, scratch);
      const hasPhysics = s.data.constraints.some((c) => c.kind === 'physics');
      if (hasPhysics) {
        s.update(player.playing ? dt * player.speed : 0);
        s.updateWorldTransform(physicsReset ? 'reset' : player.playing ? 'update' : 'pose');
        physicsReset = false;
      } else s.updateWorldTransform();
      const prefs = settingsStore.get();
      renderer.setSmoothing(prefs.smoothing);
      renderer.begin({ x: cam.current.x, y: cam.current.y, scale: cam.current.zoom * dpr, width: el.width, height: el.height }, [
        ...prefs.viewportBg,
        1,
      ]);
      const hidden = new Set(p.skeleton.slots.filter((x) => x.hidden).map((x) => x.id));
      renderer.drawSkeleton(s, { skip: (slot) => hidden.has(slot.data.id) });
      renderer.end();
      mirrorToPopout(el, [prefs.viewportBg[0], prefs.viewportBg[1], prefs.viewportBg[2]]);
    };

    const reportEvent = (k: EventKey, defs: readonly { id: Id; name: string }[]): Fired => {
      const def = defs.find((e) => e.id === k.event);
      return { id: ++logId.current, text: def?.name ?? '?', sound: playEventSound(defs as EventDef[], k) };
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);

  const options = [{ value: SETUP, label: '— setup pose —' }, ...animations.map((a) => ({ value: a.id, label: a.name }))];
  const nameOf = (id: Id) => animations.find((a) => a.id === id)?.name ?? '?';
  const pairs = mixes?.pairs ?? [];
  const from = animations.some((a) => a.id === pairFrom) ? pairFrom : (animations[0]?.id ?? '');
  const to = animations.some((a) => a.id === pairTo) && pairTo !== from ? pairTo : (animations.find((a) => a.id !== from)?.id ?? '');
  const animOptions = animations.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div className="panel" style={{ minHeight: 120 }}>
      <div className="panel-head">
        <span className="title">Preview</span>
        <IconButton icon={playing ? Pause : Play} title={playing ? 'Pause' : 'Play'} small onClick={() => setPlaying(!playing)} />
        <IconButton icon={RotateCcw} title="Play the animation again from the start" small onClick={restart} />
        <IconButton icon={Maximize2} title="Fit the view to the animation" small onClick={() => (fit.current = true)} />
        <IconButton
          icon={ExternalLink}
          title="Open the preview in its own window (for a second monitor)"
          small
          onClick={() => {
            const bg = settingsStore.get().viewportBg;
            if (!openPopout([bg[0], bg[1], bg[2]])) toast('The browser blocked the window: allow pop-ups for this site', 'error');
          }}
        />
        <IconButton
          icon={soundCount() ? Volume2 : VolumeX}
          title="Load sound files: an event plays the one with the name of its sound (folders and extension do not count)"
          small
          onClick={() => pickSounds(setSounds)}
        />
      </div>
      <div className="panel-body" style={{ padding: 8 }}>
        <canvas ref={canvas} style={{ width: '100%', height: HEIGHT, display: 'block', borderRadius: 4 }} />
        <Field label="Animation">
          <SelectField value={animId} options={options} onChange={choose} />
        </Field>
        <Field label="Loop">
          <Toggle on={loop} onChange={setLoop} title="Start again when the animation ends" />
        </Field>
        <Field label="Speed">
          <NumberField
            label="×"
            value={speed}
            step={0.1}
            precision={2}
            min={0.05}
            max={4}
            onChange={(v) => setSpeed(Math.max(0.05, Math.min(4, v)))}
          />
        </Field>
        <Field
          label="Hold previous"
          title="While the Preview changes from one animation to another, what the new one does not key stays as the old one had it, instead of fading to the setup pose"
        >
          <Toggle on={hold} onChange={setHold} title="Hold previous" />
        </Field>
        <Field
          label="Mix"
          title="How long the crossfade lasts when the Preview changes from one animation to another (seconds); the pairs below have their own"
        >
          <NumberField label="s" value={mixes?.default ?? 0} step={0.05} precision={2} min={0} max={10} onChange={setDefaultMix} />
        </Field>
        {pairs.map((p) => (
          <Field key={`${p.from}|${p.to}`} label={`${nameOf(p.from)} →`} title={`${nameOf(p.from)} → ${nameOf(p.to)}`}>
            <span className="dim" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nameOf(p.to)}
            </span>
            <NumberField
              label="s"
              value={p.time}
              step={0.05}
              precision={2}
              min={0}
              max={10}
              onChange={(v) => setMixPair(p.from, p.to, v)}
            />
          </Field>
        ))}
        {animations.length > 1 && (
          <Field label="Pair" title="A crossfade time for one pair of animations">
            <SelectField value={from} options={animOptions} onChange={setPairFrom} />
            <SelectField value={to} options={animOptions.filter((o) => o.value !== from)} onChange={setPairTo} />
            <Button
              icon={Plus}
              small
              disabled={!from || !to}
              onClick={() =>
                setMixPair(from, to, mixes?.pairs.find((p) => p.from === from && p.to === to)?.time ?? (mixes?.default ?? 0) + 0.2)
              }
              title="Give this pair a time of its own (then change it in the list)"
            >
              Add
            </Button>
          </Field>
        )}
        {animations.length > 0 && (
          <div className="preview-layers">
            <div className="hstack">
              <span className="title">Layers</span>
              <Button
                icon={Layers}
                small
                onClick={() =>
                  setLayers((old) => [
                    ...old,
                    { animId: animations.find((a) => a.id !== animId)?.id ?? animations[0].id, alpha: 1, additive: false, loop: true },
                  ])
                }
                title="Play another animation over this one: it moves only what it keys. Full strength replaces, a lower one blends, additive adds its change to the pose"
              >
                Add layer
              </Button>
            </div>
            {layers.map((l, i) => (
              <Field key={i} label="Layer">
                <SelectField
                  value={animations.some((a) => a.id === l.animId) ? l.animId : ''}
                  options={animOptions}
                  onChange={(v) => setLayer(i, { animId: v })}
                />
                <NumberField
                  label="α"
                  value={l.alpha}
                  step={0.05}
                  precision={2}
                  min={0}
                  max={1}
                  title="How much of the layer shows (0 to 1)"
                  onChange={(v) => setLayer(i, { alpha: Math.max(0, Math.min(1, v)) })}
                />
                <Toggle
                  on={l.additive}
                  onChange={(v) => setLayer(i, { additive: v })}
                  title="Additive: adds the layer's change from the setup pose to the pose below it"
                />
                <Toggle on={l.loop} onChange={(v) => setLayer(i, { loop: v })} title="Loop this layer" />
                <IconButton
                  icon={Trash2}
                  title="Remove this layer"
                  small
                  onClick={() => setLayers((old) => old.filter((_, k) => k !== i))}
                />
              </Field>
            ))}
          </div>
        )}
        {fired.length > 0 && (
          <div className="hstack wrap" style={{ marginTop: 4 }}>
            {fired.map((f) => (
              <span key={f.id} className={`chip${f.sound ? ' accent' : ''}`} title={f.sound ? 'Event with its sound' : 'Event'}>
                {f.text}
              </span>
            ))}
          </div>
        )}
        {sounds > 0 && <p className="hint-text">{`${sounds} sounds loaded; an event plays the sound with the name of its audio path`}</p>}
        {sounds === 0 && doc.events.some((e) => e.audio && !hasSound(e.audio)) && (
          <p className="hint-text">Some events have a sound; load the files with the speaker button to hear them.</p>
        )}
      </div>
    </div>
  );
}
