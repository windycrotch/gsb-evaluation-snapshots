import { Brush, Hexagon, Palette } from 'lucide-react';
import { useProject } from '@/store/doc';
import { FLOAT_LIST, useFloats } from '@/store/floats';
import { useUi } from '@/store/ui';
import { FloatingWindow } from '../ui/FloatingWindow';
import { ConvertToMeshGroup, MeshGroup } from './MeshInspector';
import { SlotColorFields } from './InspectorPanel';

/** The floating tool windows that are open: Slot color, Mesh tools and Weights (Spine's floating panels). They follow the selected slot and picture. */
export function FloatingPanels() {
  const open = useFloats((s) => s.open);
  const slotId = useUi((s) => s.selection.slot);
  const attachment = useUi((s) => s.selection.attachment);
  const mode = useUi((s) => s.mode);
  const doc = useProject().skeleton;
  const slot = slotId ? doc.slots.find((s) => s.id === slotId) : undefined;
  const att = slot && attachment ? doc.skins[0]?.attachments[slot.id]?.[attachment] : undefined;
  const mesh = att?.type === 'mesh' ? att : undefined;
  const none = (text: string) => <div className="empty">{text}</div>;
  return (
    <>
      {open.slotColor && (
        <FloatingWindow id="slotColor" title={FLOAT_LIST[0].label} icon={Palette}>
          <div className="group">{slot ? <SlotColorFields slotId={slot.id} /> : none('Select a slot to edit its tint.')}</div>
        </FloatingWindow>
      )}
      {open.meshTools && (
        <FloatingWindow id="meshTools" title={FLOAT_LIST[1].label} icon={Hexagon}>
          {slot && mesh ? (
            <MeshGroup slotId={slot.id} att={mesh} part="main" />
          ) : slot && att?.type === 'region' && mode === 'setup' ? (
            <ConvertToMeshGroup slotId={slot.id} name={att.name} />
          ) : (
            none('Select a mesh or an image to see its mesh tools.')
          )}
        </FloatingWindow>
      )}
      {open.weights && (
        <FloatingWindow id="weights" title={FLOAT_LIST[2].label} icon={Brush} width={320}>
          {slot && mesh ? <MeshGroup slotId={slot.id} att={mesh} part="weights" /> : none('Select a mesh to paint and edit its weights.')}
        </FloatingWindow>
      )}
    </>
  );
}
