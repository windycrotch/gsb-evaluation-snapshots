import { ChevronLeft, ChevronRight, Pause, Play, Volume2 } from 'lucide-react';
import { pickSounds } from '@/store/sounds';
import { playSpan } from '@/core/playback';
import { keyGrid } from '@/core/edit';
import { currentAnimation, setPlay, setTime, togglePlay } from '@/store/actions';
import { useProject } from '@/store/doc';
import { uiStore, useUi } from '@/store/ui';
import { KEYS } from '../hotkeys';
import { Field } from '../ui/Field';
import { Button, IconButton, NumberField, Toggle } from '../ui/controls';

const SPEEDS = [0.25, 0.5, 1, 2];

/** The Playback window (Spine's Playback view): speed, looping, ping-pong and a loop range of the animation. */
export function PlaybackPanel() {
  const project = useProject();
  const fps = project.skeleton.fps;
  const { speed, stepped, loop, pingPong, range, time, playing, animationId } = useUi((s) => ({
    speed: s.speed,
    stepped: s.stepped,
    loop: s.loop,
    pingPong: s.pingPong,
    range: s.range,
    time: s.time,
    playing: s.playing,
    animationId: s.animationId,
  }));
  const anim = project.skeleton.animations.find((a) => a.id === animationId) ?? currentAnimation();
  const duration = anim?.duration ?? 0;
  const [lo, hi] = playSpan(duration, range);
  const setRange = (start: number, end: number) => {
    const a = Math.max(0, Math.min(start, duration));
    const b = Math.max(0, Math.min(end, duration));
    setPlay({ range: b - a >= 1 / Math.max(1, fps) ? [a, b] : null });
  };

  return (
    <div className="panel grow" style={{ minHeight: 160 }}>
      <div className="panel-head">
        <span className="title">Playback</span>
        <span className="dim row-meta">{anim ? anim.name : ''}</span>
        <IconButton
          icon={Volume2}
          small
          title="Load sound files: the events that have a sound play it while the animation plays (the file name, without folders and extension, is the name of the event's sound)"
          onClick={() => pickSounds()}
        />
      </div>
      <div className="panel-body pad">
        <div className="hstack mb">
          <IconButton icon={ChevronLeft} title="Previous frame" onClick={() => setTime(time - 1 / fps)} disabled={!anim} />
          <IconButton
            icon={playing ? Pause : Play}
            title={playing ? 'Pause' : 'Play'}
            hotkey={KEYS.play}
            active={playing}
            animate
            onClick={() => togglePlay()}
            disabled={!anim}
          />
          <IconButton icon={ChevronRight} title="Next frame" onClick={() => setTime(time + 1 / fps)} disabled={!anim} />
          <span className="dim grow row-meta">
            {anim
              ? `${time.toFixed(2)} s · frame ${keyGrid.steps > 1 ? Math.round(time * fps * 100) / 100 : Math.round(time * fps)}`
              : 'no animation'}
          </span>
        </div>

        <Field label="Speed" title="Playback speed: 1 is real time">
          <NumberField label="×" value={speed} step={0.05} precision={2} min={0.05} max={8} onChange={(v) => uiStore.patch({ speed: v })} />
        </Field>
        <div className="hstack mb">
          {SPEEDS.map((s) => (
            <Button key={s} small ghost={speed !== s} primary={speed === s} onClick={() => uiStore.patch({ speed: s })}>
              {`${s}×`}
            </Button>
          ))}
        </div>

        <Field
          label="By frames"
          title="Show the pose at the start of each frame, like a game that runs at the animation's frame rate; off draws the motion between frames"
        >
          <Toggle on={stepped} onChange={(v) => uiStore.patch({ stepped: v })} title="By frames" />
        </Field>
        <Field label="Loop" title="Start again when the end is reached">
          <Toggle on={loop} onChange={(v) => setPlay({ loop: v })} title="Loop" />
        </Field>
        <Field label="Ping-pong" title="Play forward, then backward, instead of jumping back to the start">
          <Toggle on={pingPong} onChange={(v) => setPlay({ pingPong: v })} title="Ping-pong" />
        </Field>

        <div className="section-label flush">Play range</div>
        <p className="hint-text">
          {range ? 'Only this part plays and loops.' : 'The whole animation plays. Set a start and an end to work on a part of it.'}
        </p>
        <Field label="Start" title="Where the range begins, in seconds">
          <NumberField
            label="s"
            value={lo}
            step={1 / Math.max(1, fps)}
            precision={2}
            min={0}
            max={duration}
            disabled={!anim}
            onChange={(v) => setRange(v, range ? hi : duration)}
          />
        </Field>
        <Field label="End" title="Where the range ends, in seconds">
          <NumberField
            label="s"
            value={hi}
            step={1 / Math.max(1, fps)}
            precision={2}
            min={0}
            max={duration}
            disabled={!anim}
            onChange={(v) => setRange(range ? lo : 0, v)}
          />
        </Field>
        <div className="hstack">
          <Button small ghost disabled={!anim} onClick={() => setRange(time, range ? hi : duration)}>
            Start here
          </Button>
          <Button small ghost disabled={!anim} onClick={() => setRange(range ? lo : 0, time)}>
            End here
          </Button>
          <Button small ghost disabled={!range} onClick={() => setPlay({ range: null })}>
            Whole animation
          </Button>
        </div>
      </div>
    </div>
  );
}
