import { useEditorStore } from '../store/editorStore';
import { isWebContainer, isValidWebParent, newWebElement, type WebElementKind } from '../types/web';
import { Object3D } from 'three';
import { toast } from 'react-hot-toast';

const kinds: { kind: WebElementKind; label: string }[] = [
  { kind: 'section', label: 'Section' }, { kind: 'columns', label: 'Columns' },
  { kind: 'container', label: 'Container' }, { kind: 'card', label: 'Card' },
  { kind: 'slider', label: 'Slider' }, { kind: 'slide', label: 'Slide' },
  { kind: 'heading', label: 'Heading' }, { kind: 'text', label: 'Text' },
  { kind: 'button', label: 'Button' }, { kind: 'menu', label: 'Menu' },
  { kind: 'image', label: 'Image' }, { kind: 'video', label: 'Video' }, { kind: 'audio', label: 'Audio' }, { kind: 'lottie', label: 'Lottie' }
];

export function WebElements() {
  const { selectedObject, sceneObjects, addObject, setSelectedObject } = useEditorStore();
  function add(kind: WebElementKind, label: string) {
    const selected = selectedObject?.properties.web;
    const parentId = kind === 'slide' && selected?.kind === 'slide'
      ? selected.parentId : selected && isWebContainer(selected.kind)
        ? selectedObject!.id : selected?.parentId ?? null;
    const parentKind = sceneObjects.find(object => object.id === parentId)?.properties.web?.kind;
    if (!isValidWebParent(kind, parentKind)) {
      toast.error(kind === 'slide' ? 'Select a slider or one of its slides first.' : 'Select a slide to add content inside a slider.');
      return;
    }
    const makeItem = (itemKind: WebElementKind, name: string, parent: string | null) => ({
      id: crypto.randomUUID(), name, type: 'web', object: new Object3D(),
      properties: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        web: newWebElement(itemKind, parent)
      }
    });
    const item = makeItem(kind, label, parentId);
    addObject(item);
    if (kind === 'slider') {
      const slide = makeItem('slide', 'Slide 1', item.id);
      addObject(slide);
      setSelectedObject(slide);
    } else {
      setSelectedObject(item);
    }
  }
  return <section className="mt-6 border-t border-gray-600 pt-4">
    <h3 className="mb-2 font-semibold text-white">Web Components</h3>
    <p className="mb-3 text-xs text-gray-300">Select a container or slide to add children. Select a slider or slide to add another slide.</p>
    <div className="grid grid-cols-2 gap-2">
      {kinds.map(({ kind, label }) => <button key={kind} aria-label={`Add web ${label.toLowerCase()}`}
        className="rounded bg-slate-700 p-2 text-sm text-white hover:bg-slate-600" onClick={() => add(kind, label)}>+ {label}</button>)}
    </div>
  </section>;
}
