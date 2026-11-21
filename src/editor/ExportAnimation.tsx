import { useEffect, useMemo, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import { useProject } from '@/store/doc';
import { downloadBlob } from '@/store/project';
import { CANCELLED, encodeInWorker } from '@/store/encodeInWorker';
import type { EncodeJob } from '@/store/encodeInWorker';
import { toast } from '@/store/ui';
import { Button, ColorSwatch, NumberField, SelectField, Toggle } from './ui/controls';
import { Segmented } from './ui/Segmented';
import { frameCount, framesToWebm, frameToJpeg, frameToPng, prepareRender } from './renderAnimation';
import { frameDelay } from '@/core/export/apng';
import type { Prepared } from './renderAnimation';

type Format = 'gif' | 'apng' | 'png' | 'jpeg' | 'webm';

const FORMAT_NOTE: Record<Format, string> = {
  gif: 'One animated picture that plays anywhere. 256 colors, transparency is on or off.',
  apng: 'One animated PNG: full color and soft transparency, plays in browsers like a picture.',
  png: 'A ZIP with one PNG per frame, full color and soft transparency: for sprite sheets and video editors.',
  jpeg: 'A ZIP with one JPEG per frame. Small files, no transparency: for previews and video editors.',
  webm: 'A video, recorded in real time by the browser (it takes as long as the animation). It has no transparency.',
};

const sleep = () => new Promise((r) => setTimeout(r, 0)); // lets the window repaint between frames

/** The Animation tab of the export window: render an animation to a GIF, a PNG sequence or a WebM video. */
export function ExportAnimation() {
  const project = useProject();
  const doc = project.skeleton;
  const [animId, setAnimId] = useState(doc.animations[0]?.id ?? '');
  const [format, setFormat] = useState<Format>('gif');
  const [fps, setFps] = useState(String(Math.min(60, Math.max(12, doc.fps))));
  const [scale, setScale] = useState('1');
  const [pad, setPad] = useState('8');
  // the frames rendered (to = null: up to the end) and the seconds of warm up before them
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState<number | null>(null);
  const [warm, setWarm] = useState(0);
  const [transparent, setTransparent] = useState(true);
  const [bg, setBg] = useState<[number, number, number]>([0.075, 0.082, 0.1]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);
  /** The encoder that is running in the worker, to stop it with Cancel. */
  const job = useRef<EncodeJob | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  const anim = doc.animations.find((a) => a.id === animId) ?? null;
  const total = anim ? frameCount(anim.duration, +fps) : 1;
  const solid = format === 'webm' || format === 'jpeg' || !transparent;
  const background = useMemo(() => (solid ? bg : null), [solid, bg]);

  // the picture the settings give: a first frame to look at, and the size of the files
  useEffect(() => {
    if (!anim) return setPrepared(null);
    let made: Prepared | null = null;
    const timer = setTimeout(() => {
      try {
        made = prepareRender({
          doc,
          animation: anim,
          fps: +fps,
          scale: +scale,
          padding: +pad,
          background,
          from,
          to: to ?? undefined,
          warmUp: warm,
        });
        setPrepared(made);
        setError(null);
      } catch (e) {
        setPrepared(null);
        setError((e as Error).message);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      made?.dispose();
    };
  }, [doc, anim, fps, scale, pad, background, from, to, warm]);

  useEffect(() => {
    if (!prepared || !canvas.current) return;
    const i = Math.min(frameIndex, prepared.count - 1);
    const image = prepared.frame(i);
    canvas.current.width = image.width;
    canvas.current.height = image.height;
    canvas.current.getContext('2d')!.putImageData(image, 0, 0);
  }, [prepared, frameIndex]);

  const run = async () => {
    if (!prepared || !anim || progress !== null) return;
    cancel.current = false;
    setProgress(0);
    const base = (doc.name || 'skeleton').replace(/[^\w-]+/g, '_') + '-' + anim.name.replace(/[^\w-]+/g, '_');
    try {
      if (format === 'webm') {
        const blob = await framesToWebm(
          prepared,
          (n) => setProgress(n / prepared.count),
          () => cancel.current,
        );
        if (!cancel.current) downloadBlob(blob, `${base}.webm`);
      } else if (format === 'gif') {
        const frames: Uint8ClampedArray[] = [];
        for (let i = 0; i < prepared.count && !cancel.current; i++) {
          frames.push(new Uint8ClampedArray(prepared.frame(i).data));
          setProgress((i + 1) / prepared.count / 2);
          await sleep();
        }
        if (!cancel.current) {
          // the frames are handed to the worker: the window stays alive while the colors are chosen and the pixels packed
          job.current = encodeInWorker(
            {
              kind: 'gif',
              frames,
              options: { width: prepared.width, height: prepared.height, delayCs: 100 / prepared.fps, transparent: !solid },
            },
            (f) => setProgress(0.5 + f / 2),
          );
          downloadBlob(new Blob([(await job.current.result) as BlobPart], { type: 'image/gif' }), `${base}.gif`);
        }
      } else if (format === 'apng') {
        const frames: Uint8Array[] = [];
        for (let i = 0; i < prepared.count && !cancel.current; i++) {
          frames.push(await frameToPng(prepared.frame(i)));
          setProgress((i + 1) / prepared.count);
        }
        if (!cancel.current) {
          job.current = encodeInWorker({ kind: 'apng', frames, options: { ...frameDelay(prepared.fps), plays: 0 } });
          downloadBlob(new Blob([(await job.current.result) as BlobPart], { type: 'image/apng' }), `${base}.png`);
        }
      } else if (format === 'jpeg') {
        const files: { name: string; data: Uint8Array }[] = [];
        for (let i = 0; i < prepared.count && !cancel.current; i++) {
          files.push({ name: `${base}_${String(i + 1).padStart(4, '0')}.jpg`, data: await frameToJpeg(prepared.frame(i)) });
          setProgress((i + 1) / prepared.count);
        }
        if (!cancel.current) {
          job.current = encodeInWorker({ kind: 'zip', files });
          downloadBlob(new Blob([(await job.current.result) as BlobPart], { type: 'application/zip' }), `${base}-frames.zip`);
        }
      } else {
        const files: { name: string; data: Uint8Array }[] = [];
        for (let i = 0; i < prepared.count && !cancel.current; i++) {
          files.push({ name: `${base}_${String(i + 1).padStart(4, '0')}.png`, data: await frameToPng(prepared.frame(i)) });
          setProgress((i + 1) / prepared.count);
        }
        if (!cancel.current) {
          job.current = encodeInWorker({ kind: 'zip', files });
          downloadBlob(new Blob([(await job.current.result) as BlobPart], { type: 'application/zip' }), `${base}-frames.zip`);
        }
      }
      if (!cancel.current) toast('Animation exported', 'ok');
    } catch (e) {
      if (!(cancel.current && (e as Error).message === CANCELLED)) toast((e as Error).message, 'error');
    } finally {
      job.current = null;
      setProgress(null);
    }
  };

  if (!doc.animations.length) return <p className="hint-text">Make an animation first: it is rendered frame by frame.</p>;

  return (
    <div className="export-anim">
      <div className="kv">
        <label>Animation</label>
        <SelectField
          name="Animation"
          value={animId}
          options={doc.animations.map((a) => ({ value: a.id, label: a.name }))}
          onChange={setAnimId}
        />
        <label>Format</label>
        <Segmented
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { value: 'gif', label: 'GIF', tone: 'plain' },
            { value: 'apng', label: 'APNG', tone: 'plain' },
            { value: 'png', label: 'PNG frames', tone: 'plain' },
            { value: 'jpeg', label: 'JPEG frames', tone: 'plain' },
            { value: 'webm', label: 'WebM video', tone: 'plain' },
          ]}
        />
        <label>Frame rate</label>
        <SelectField
          name="Frame rate"
          value={fps}
          options={['12', '15', '24', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
          onChange={setFps}
        />
        <label>Size</label>
        <SelectField
          name="Size"
          value={scale}
          options={['0.25', '0.5', '1', '1.5', '2'].map((v) => ({ value: v, label: `${+v * 100}%` }))}
          onChange={setScale}
        />
        <label>Margin</label>
        <SelectField
          name="Margin"
          value={pad}
          options={['0', '4', '8', '16', '32'].map((v) => ({ value: v, label: `${v} px` }))}
          onChange={setPad}
        />
        <label>Frames</label>
        <div className="hstack">
          <NumberField
            label="from"
            value={from}
            step={1}
            precision={0}
            min={0}
            max={Math.max(0, total - 1)}
            onChange={(v) => setFrom(Math.max(0, Math.min(total - 1, Math.round(v))))}
            title="The first frame that is rendered (the animation has frames 0 to the last one)"
          />
          <NumberField
            label="to"
            value={to ?? total}
            step={1}
            precision={0}
            min={1}
            max={total}
            onChange={(v) => setTo(v >= total ? null : Math.max(1, Math.round(v)))}
            title="Rendering stops before this frame (the end of the animation is the last frame plus one)"
          />
        </div>
        <label>Warm up</label>
        <NumberField
          label="s"
          value={warm}
          step={0.25}
          precision={2}
          min={0}
          max={20}
          onChange={(v) => setWarm(Math.max(0, Math.min(20, v)))}
          title="Seconds the animation runs before the first frame, as if it had been looping, so the physics has settled (only for a skeleton with physics)"
        />
        <label>Background</label>
        <div className="hstack">
          {format !== 'webm' && format !== 'jpeg' && <Toggle on={transparent} onChange={setTransparent} title="Transparent background" />}
          {format !== 'webm' && format !== 'jpeg' && <span className="dim">Transparent</span>}
          {solid && <ColorSwatch value={bg} onChange={setBg} title="Background color" />}
        </div>
      </div>
      <p className="hint-text">{FORMAT_NOTE[format]}</p>
      <div className="card roomy export-preview">
        {error && <span className="danger-text">{error}</span>}
        {prepared && (
          <>
            <div className={`preview-frame${solid ? '' : ' checker'}`}>
              <canvas ref={canvas} />
            </div>
            <div className="hstack dim">
              <Film size={15} />
              {`${prepared.width}×${prepared.height} px · ${prepared.count} frames · ${(prepared.count / prepared.fps).toFixed(2)} s`}
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, prepared.count - 1)}
              value={Math.min(frameIndex, prepared.count - 1)}
              onChange={(e) => setFrameIndex(+e.target.value)}
              aria-label="Preview frame"
            />
          </>
        )}
      </div>
      <div className="hstack end">
        {progress !== null && (
          <>
            <progress value={progress} max={1} />
            <Button
              ghost
              onClick={() => {
                cancel.current = true;
                job.current?.cancel();
              }}
            >
              Cancel
            </Button>
          </>
        )}
        <Button primary icon={Film} disabled={!prepared || progress !== null} onClick={run}>
          Render
        </Button>
      </div>
    </div>
  );
}
