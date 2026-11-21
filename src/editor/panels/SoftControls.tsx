/** Soft selection controls (core/soft.ts): the Soft button and, while it is on, the radius and the falloff. Shared by the mesh and polygon inspectors. */
import { uiStore, useUi } from '@/store/ui';
import { Button, NumberField, SelectField } from '../ui/controls';
import { Field } from '../ui/Field';

export function SoftControls() {
  const meshView = useUi((s) => s.meshView);
  const patch = (p: Partial<typeof meshView>) => uiStore.patch({ meshView: { ...meshView, ...p } });
  return (
    <>
      <div className="hstack wrap mb">
        <Button
          primary={meshView.soft}
          title="Soft selection: dragging the selected vertices also pulls the ones near them, less and less with the distance"
          onClick={() => patch({ soft: !meshView.soft })}
        >
          Soft
        </Button>
      </div>
      {meshView.soft && (
        <>
          <Field label="Soft radius">
            <NumberField
              label="px"
              value={meshView.softRadius}
              step={5}
              precision={0}
              min={1}
              max={2000}
              onChange={(v) => patch({ softRadius: v })}
            />
          </Field>
          <Field label="Soft falloff">
            <SelectField
              value={meshView.softShape}
              options={[
                { value: 'smooth', label: 'Smooth' },
                { value: 'linear', label: 'Linear' },
                { value: 'sharp', label: 'Sharp' },
              ]}
              onChange={(v) => patch({ softShape: v })}
            />
          </Field>
        </>
      )}
    </>
  );
}
