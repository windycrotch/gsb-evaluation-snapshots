import { Route } from 'lucide-react';
import { boneStages, isQuiet, stageDelta } from '@/core/constraintInfo';
import type { PoseNumbers } from '@/core/constraintInfo';
import type { Id } from '@/core/model';
import { useProject } from '@/store/doc';
import { useUi } from '@/store/ui';
import { getProbeSkeleton } from '@/store/scene';
import { Section } from '../ui/Section';
import { Hint } from '../ui/controls';

const signed = (v: number, digits: number): string => {
  const s = Math.abs(v).toFixed(digits);
  return v < 0 && Number(s) !== 0 ? `−${s}` : `+${s}`;
};

/** The pose as plain numbers: where the bone stands and how it is turned and scaled. */
const poseText = (p: PoseNumbers): string => {
  const scale = Math.abs(p.scaleX - 1) > 0.005 || Math.abs(p.scaleY - 1) > 0.005 ? `  ×${p.scaleX.toFixed(2)}, ${p.scaleY.toFixed(2)}` : '';
  return `${p.rotation.toFixed(1)}°  (${p.x.toFixed(1)}, ${p.y.toFixed(1)})${scale}`;
};

/**
 * The numbers behind a constrained bone: the pose the animation gives it, what each constraint that moves it adds, and where it ends up.
 * Shown only for a bone that a constraint moves; Spine has no such view. The arrows in the viewport (View > Constraint arrows) show who drives whom.
 */
export function ConstraintEffects({ id }: { id: Id }) {
  useProject();
  useUi((s) => s.time);
  useUi((s) => s.overrides);
  useUi((s) => s.mode);
  const result = boneStages(getProbeSkeleton(), id);
  if (!result || !result.stages.length) return null;
  return (
    <Section id="bone.effects" title="Constraint effects" icon={Route}>
      <Hint>
        What the constraints do to this bone, in the order they run: its pose from the animation, the change each one makes, and the result.
      </Hint>
      <div className="effects">
        <div className="effect-row">
          <span className="effect-name dim">From the animation</span>
          <span className="effect-num">{poseText(result.start)}</span>
        </div>
        {result.stages.map((s) => {
          const d = stageDelta(s);
          const quiet = isQuiet(d);
          return (
            <div key={s.id} className="effect-row">
              <span className={`effect-name k-${s.kind}`} title={s.kind}>
                {s.name}
                {s.strength < 1 && <span className="dim">{` ${Math.round(s.strength * 100)}%`}</span>}
              </span>
              <span className="effect-num">
                {quiet ? (
                  <span className="dim">no change</span>
                ) : (
                  <>
                    {Math.abs(d.rotation) >= 0.05 && <span>{`${signed(d.rotation, 1)}°  `}</span>}
                    {(Math.abs(d.x) >= 0.05 || Math.abs(d.y) >= 0.05) && <span>{`(${signed(d.x, 1)}, ${signed(d.y, 1)})  `}</span>}
                    {(Math.abs(d.scaleX) >= 0.005 || Math.abs(d.scaleY) >= 0.005) && (
                      <span>{`×${signed(d.scaleX, 2)}, ${signed(d.scaleY, 2)}  `}</span>
                    )}
                    {Math.abs(d.shearY) >= 0.05 && <span>{`shear ${signed(d.shearY, 1)}°`}</span>}
                  </>
                )}
              </span>
            </div>
          );
        })}
        <div className="effect-row total">
          <span className="effect-name">Result</span>
          <span className="effect-num">{poseText(result.end)}</span>
        </div>
      </div>
    </Section>
  );
}
