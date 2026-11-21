import { useMemo, useState } from 'react';
import { NAME_KINDS } from '@/core/rename';
import type { NameKind } from '@/core/rename';
import { useProject } from '@/store/doc';
import { findReplaceNames, previewRename, renameScope } from '@/store/renameActions';
import type { RenameWhere } from '@/store/renameActions';
import { useUi } from '@/store/ui';
import { Button, SelectField } from '../ui/controls';

const KIND_LABEL: Record<NameKind, string> = {
  bone: 'Bones',
  slot: 'Slots',
  skin: 'Skins',
  event: 'Events',
  constraint: 'Constraints',
  animation: 'Animations',
  image: 'Pictures',
};

/** Find and replace for names, under the Hierarchy filter: the count of what would change shows while typing, Replace does it as one step. */
export function RenameBar() {
  const doc = useProject().skeleton;
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [firstOnly, setFirstOnly] = useState(false);
  const [kinds, setKinds] = useState<NameKind[]>(['bone', 'slot']);
  const [where, setWhere] = useState<RenameWhere>('all');
  // the selection and the chosen skin are dependencies on purpose: the count follows them
  const selection = useUi((s) => s.selection);
  const skinId = useUi((s) => s.skinId);
  const opts = { find, replace, regex, matchCase, firstOnly, kinds, scope: renameScope(where) };
  // `doc` is a dependency on purpose: the count follows the document
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `opts` is built from the listed values
  const plan = useMemo(() => previewRename(opts), [doc, find, replace, regex, matchCase, firstOnly, kinds, where, selection, skinId]);
  const flip = (k: NameKind) => setKinds((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="rename-bar">
      <input value={find} placeholder="Find" onChange={(e) => setFind(e.target.value)} onKeyDown={stop} />
      <input value={replace} placeholder="Replace with" onChange={(e) => setReplace(e.target.value)} onKeyDown={stop} />
      <div className="rename-opts">
        <label title="The text to find is a regular expression; $1 in the replacement is the first group">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regex
        </label>
        <label title="Capital and small letters differ">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
        </label>
        <label title="Only the first match inside each name">
          <input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} /> First only
        </label>
      </div>
      <div className="rename-opts">
        {NAME_KINDS.map((k) => (
          <label key={k}>
            <input type="checkbox" checked={kinds.includes(k)} onChange={() => flip(k)} /> {KIND_LABEL[k]}
          </label>
        ))}
      </div>
      <div className="rename-opts">
        <SelectField
          label="Where"
          value={where}
          onChange={setWhere}
          options={[
            { value: 'all', label: 'Everywhere' },
            { value: 'selection', label: 'Selection only' },
            { value: 'skin', label: 'Chosen skin only' },
          ]}
        />
      </div>
      <div className="rename-go">
        <span className="hint-text">
          {plan.invalid
            ? 'Not a valid expression'
            : find
              ? `${plan.changes.length} to rename${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ''}`
              : ' '}
        </span>
        <Button
          small
          primary
          disabled={!plan.changes.length}
          title="Rename every name that matches, as one step of the history"
          onClick={() => void findReplaceNames(opts)}
        >
          Replace
        </Button>
      </div>
    </div>
  );
}
