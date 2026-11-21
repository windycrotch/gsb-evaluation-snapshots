import { Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { selectionIs } from '@/core/selsets';
import { useProject } from '@/store/doc';
import { askName } from '@/store/ask';
import { deleteSelectionSet, renameSelectionSet, saveSelectionSet, selectSet, updateSelectionSet } from '@/store/selectionSetActions';
import { useUi } from '@/store/ui';
import { IconButton } from '../ui/controls';

/** The selection sets of the skeleton as a row of buttons under the Hierarchy filter: a click selects the bones of a set, Shift adds them. */
export function SelectionSets() {
  const doc = useProject().skeleton;
  const selected = useUi((s) => s.selection.bones);
  const sets = doc.selectionSets ?? [];
  const keep = async () => {
    if (!selected.length) {
      saveSelectionSet();
      return;
    }
    const name = await askName('Selection set', 'Name for the selected bones', 'Set');
    if (name) saveSelectionSet(name);
  };
  return (
    <div className="sel-sets">
      <IconButton
        icon={Plus}
        title={
          selected.length
            ? 'Keep the selected bones as a set: one click selects them again'
            : 'Select some bones first, then keep them as a set'
        }
        small
        onClick={() => void keep()}
      />
      {sets.length === 0 && <span className="hint-text">Selection sets</span>}
      {sets.map((s) => {
        const on = selected.length > 0 && selectionIs(doc, s, selected);
        return (
          <span key={s.id} className={`sel-set${on ? ' on' : ''}`}>
            <button
              type="button"
              className="sel-set-name"
              title="Click: select these bones. Shift+click: add them to the selection"
              onClick={(e) => selectSet(s.id, e.shiftKey)}
            >
              {s.name}
              <span className="dim">{` ${s.bones.length}`}</span>
            </button>
            {on && (
              <>
                <IconButton
                  icon={RefreshCw}
                  title="Replace the bones of this set with the selected ones"
                  small
                  onClick={() => updateSelectionSet(s.id)}
                />
                <IconButton
                  icon={Pencil}
                  title="Rename this set"
                  small
                  onClick={async () => {
                    const name = await askName('Rename set', 'Name of the set', s.name, 'Rename');
                    if (name) renameSelectionSet(s.id, name);
                  }}
                />
                <IconButton icon={X} title="Delete this set (the bones stay)" small onClick={() => deleteSelectionSet(s.id)} />
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}
