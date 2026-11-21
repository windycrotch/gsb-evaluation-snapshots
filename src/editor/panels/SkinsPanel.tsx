import { useMemo, useState } from 'react';
import {
  Copy,
  CopyPlus,
  FolderInput,
  Merge,
  Layers,
  Lock,
  LockOpen,
  Palette,
  Pencil,
  Pin,
  Plus,
  Trash2,
  Link2,
  Bone as BoneIcon,
} from 'lucide-react';
import type { Bone, Constraint, Id, Project, SkeletonDoc, Skin } from '@/core/model';
import { overrideCount, overrideState } from '@/core/skins';
import type { DuplicateSkinOptions, MergeSkinOptions } from '@/core/skins';
import { planSkinImages, suggestSkinPrefixes } from '@/core/skinImages';
import {
  createSkin,
  createSkinFromImages,
  deleteSkin,
  duplicateSkinAction,
  mergeSkinAction,
  renameSkin,
  setActiveSkin,
  toggleSkinMix,
  toggleSkinPin,
  setSkinRequiredAction,
  setSkinScopeAction,
  toggleSkinOverride,
} from '@/store/actions';
import { useProject } from '@/store/doc';
import { useUi } from '@/store/ui';
import { Button, IconButton, SelectField, Toggle } from '../ui/controls';

/** Bones in tree order with their depth (parents come first in the document, so one pass is enough). */
function boneRows(doc: SkeletonDoc): { bone: Bone; depth: number }[] {
  const depth = new Map<Id, number>();
  return doc.bones.map((bone) => {
    const d = bone.parent ? (depth.get(bone.parent) ?? 0) + 1 : 0;
    depth.set(bone.id, d);
    return { bone, depth: d };
  });
}

/** One bone or constraint of the scope list: the lock says it is only active in the skins that list it, the box says this skin does. */
function ScopeRow(props: {
  kind: 'bone' | 'constraint';
  id: Id;
  name: string;
  icon: React.ReactNode;
  depth?: number;
  required: boolean;
  inSkin: boolean;
  skin: Skin | null;
}) {
  const { kind, id, required, skin } = props;
  return (
    <div className="row scope-row" style={{ paddingLeft: 8 + (props.depth ?? 0) * 12 }}>
      <span className="ico">{props.icon}</span>
      <span className={`label${required ? '' : ' dim'}`}>{props.name}</span>
      <input
        type="checkbox"
        className="scope-check"
        aria-label="In this skin"
        data-tip={skin ? 'Active in this skin' : 'Select a skin to choose'}
        disabled={!skin || !required}
        checked={required && props.inSkin}
        onChange={(e) => skin && setSkinScopeAction(skin.id, kind, id, e.target.checked)}
      />
      <IconButton
        icon={required ? Lock : LockOpen}
        title={
          required
            ? 'Skin required: only active in the skins that list it. Click to make it always active'
            : 'Always active. Click to make it active only in the skins that list it'
        }
        small
        active={required}
        onClick={() => setSkinRequiredAction(kind, id, !required)}
      />
    </div>
  );
}

/** Makes a skin from the pictures that carry a prefix: the prefixes the pictures suggest, or one typed. */
/** Duplicate a skin with a say in what comes along: its name, the bones and constraints it brings, the animation keys, the links of linked meshes. */
function DuplicateOptions({ skin, onDone }: { skin: Skin; onDone: () => void }) {
  const [opts, setOpts] = useState<Required<DuplicateSkinOptions>>({ name: '', scope: true, animations: true, relink: true });
  const [find, setFind] = useState('');
  const [swap, setSwap] = useState('');
  const row = (label: string, key: 'scope' | 'animations' | 'relink', tip: string) => (
    <div className="hstack" title={tip}>
      <span className="grow">{label}</span>
      <Toggle on={opts[key]} onChange={(v) => setOpts({ ...opts, [key]: v })} title={label} />
    </div>
  );
  const make = () => {
    duplicateSkinAction(skin.id, { ...opts, name: opts.name.trim() || undefined }, find ? { find, replace: swap } : undefined);
    onDone();
  };
  return (
    <div className="skin-from">
      <input
        value={opts.name}
        placeholder={`${skin.name} copy`}
        aria-label="Name of the copy"
        style={{ width: '100%' }}
        onChange={(e) => setOpts({ ...opts, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') make();
          e.stopPropagation();
        }}
      />
      {row('Bones and constraints', 'scope', 'The bones and constraints that exist only in this skin come along')}
      {row('Animation keys', 'animations', 'The deform and sequence keys of every animation are copied for the new skin')}
      {row(
        'Linked meshes follow the copy',
        'relink',
        'A linked mesh that follows a mesh of this skin follows the one in the copy; off, it keeps following this skin',
      )}
      <div
        className="hstack"
        title="Point the copy at other pictures: this text in the picture names becomes the text on the right, where a picture with the new name exists"
      >
        <input
          value={find}
          placeholder="Picture name has"
          aria-label="Text to find in picture names"
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <input
          value={swap}
          placeholder="becomes"
          aria-label="Text that replaces it"
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setSwap(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <Button small primary onClick={make}>
        Duplicate
      </Button>
    </div>
  );
}

/** Merge the skin into another one: its attachments are copied there; what comes along is up to the toggles. */
function MergeOptions({ doc, skin, onDone }: { doc: SkeletonDoc; skin: Skin; onDone: () => void }) {
  const targets = doc.skins.filter((s) => s.id !== skin.id);
  const [into, setInto] = useState<Id>(targets[0]?.id ?? '');
  const [opts, setOpts] = useState<Required<MergeSkinOptions>>({ overwrite: false, scope: true, animations: true });
  const row = (label: string, key: keyof MergeSkinOptions, tip: string) => (
    <div className="hstack" title={tip}>
      <span className="grow">{label}</span>
      <Toggle on={opts[key]} onChange={(v) => setOpts({ ...opts, [key]: v })} title={label} />
    </div>
  );
  return (
    <div className="skin-from">
      <SelectField wide label="Merge into" value={into} options={targets.map((s) => ({ value: s.id, label: s.name }))} onChange={setInto} />
      {row(
        'Replace attachments that exist',
        'overwrite',
        'An attachment of the other skin with the same slot and name is replaced by this one; off, it stays',
      )}
      {row('Bones and constraints', 'scope', 'The bones and constraints that exist only in this skin join the other skin')}
      {row(
        'Animation keys',
        'animations',
        'The deform and sequence keys of every animation come along for the attachments that are copied',
      )}
      <Button
        small
        primary
        disabled={!into}
        onClick={() => {
          if (mergeSkinAction(skin.id, into, opts)) onDone();
        }}
      >
        Merge
      </Button>
    </div>
  );
}

function SkinFromImages({ doc, images, onDone }: { doc: SkeletonDoc; images: Project['images']; onDone: () => void }) {
  const [prefix, setPrefix] = useState('');
  const suggestions = useMemo(() => suggestSkinPrefixes(doc, images), [doc, images]);
  const fits = useMemo(() => planSkinImages(doc, images, prefix).length, [doc, images, prefix]);
  const make = (p: string) => {
    if (createSkinFromImages(p)) onDone();
  };
  return (
    <div className="skin-from">
      <div className="hint-text skin-hint">
        A picture named like an attachment with a prefix in front (arctic/head, arctic-head) becomes the picture of that attachment in the
        skin arctic.
      </div>
      {suggestions.length > 0 && (
        <span className="skin-chips">
          {suggestions.map((s) => (
            <button
              key={s.prefix}
              type="button"
              className="chip skin-chip"
              data-tip="Make a skin from the pictures with this prefix"
              onClick={() => make(s.prefix)}
            >
              {`${s.prefix} · ${s.count}`}
            </button>
          ))}
        </span>
      )}
      <input
        value={prefix}
        placeholder="Prefix of the pictures"
        aria-label="Prefix of the pictures"
        style={{ width: '100%' }}
        onChange={(e) => setPrefix(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') make(prefix);
          e.stopPropagation();
        }}
      />
      {prefix.trim() !== '' && <div className="hint-text skin-hint">{`Attachments that get a picture: ${fits}`}</div>}
    </div>
  );
}

/**
 * The Skins window (Spine's Skins view): the skins, what the chosen one overrides from the default skin, and its scope — the bones and
 * constraints that exist only in some skins (a skin with a different outfit, a hat, a second tail).
 */
export function SkinsPanel() {
  const project = useProject();
  const doc = project.skeleton;
  const skinId = useUi((s) => s.skinId);
  const skinMix = useUi((s) => s.skinMix);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [fromImages, setFromImages] = useState(false);
  const [dupOptions, setDupOptions] = useState(false);
  const [merging, setMerging] = useState(false);
  const skinPins = useUi((s) => s.skinPins);
  const defaultSkin = doc.skins[0];
  const current = doc.skins.find((s) => s.id === skinId) ?? defaultSkin;
  const isDefault = current === defaultSkin;
  const skin = isDefault ? null : current;
  const bones = useMemo(() => boneRows(doc), [doc]);
  // a bone below a required one is required as well (the compiled skeleton does the same)
  const requiredBones = useMemo(() => {
    const set = new Set<Id>();
    for (const b of doc.bones) if (b.skinRequired || (b.parent && set.has(b.parent))) set.add(b.id);
    return set;
  }, [doc.bones]);

  const slots = doc.slots.filter((s) => Object.keys(defaultSkin?.attachments[s.id] ?? {}).length > 0);
  const constraintIcon = (c: Constraint) => <Link2 size={13} className={`k-${c.type}`} />;

  return (
    <div className="panel grow" style={{ minHeight: 160 }}>
      <div className="panel-head">
        <span className="title">Skins</span>
        <IconButton icon={Copy} title="Duplicate skin" small disabled={isDefault} onClick={() => duplicateSkinAction(current.id)} />
        <IconButton
          icon={CopyPlus}
          title="Duplicate skin with options: a name, what comes along"
          small
          disabled={isDefault}
          active={dupOptions}
          onClick={() => setDupOptions(!dupOptions)}
        />
        <IconButton
          icon={Merge}
          title="Merge this skin into another skin: its attachments are copied there"
          small
          disabled={doc.skins.length < 2}
          active={merging}
          onClick={() => setMerging(!merging)}
        />
        <IconButton
          icon={FolderInput}
          title="Skin from pictures: the pictures that carry a prefix become the pictures of a new skin"
          small
          active={fromImages}
          onClick={() => setFromImages(!fromImages)}
        />
        <IconButton icon={Plus} title="New skin" small onClick={() => createSkin()} />
      </div>
      <div className="panel-body">
        {dupOptions && !isDefault && <DuplicateOptions key={current.id} skin={current} onDone={() => setDupOptions(false)} />}
        {merging && doc.skins.length > 1 && <MergeOptions key={current.id} doc={doc} skin={current} onDone={() => setMerging(false)} />}
        {fromImages && <SkinFromImages doc={doc} images={project.images} onDone={() => setFromImages(false)} />}
        {doc.skins.map((s, i) => (
          <div
            key={s.id}
            className={`row${s === current ? ' selected' : ''}`}
            onClick={() => setActiveSkin(i === 0 ? null : s.id)}
            onDoubleClick={() => i > 0 && setRenaming(s.id)}
          >
            <span className="ico">
              <Palette size={13} />
            </span>
            {renaming === s.id ? (
              <span className="label">
                <input
                  autoFocus
                  defaultValue={s.name}
                  aria-label="Skin name"
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    renameSkin(s.id, e.target.value);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    else if (e.key === 'Escape') setRenaming(null);
                    e.stopPropagation();
                  }}
                />
              </span>
            ) : (
              <span className="label">{s.name}</span>
            )}
            <span className="dim row-meta">{i === 0 ? 'default' : `${overrideCount(s)} own`}</span>
            {i > 0 && (
              <IconButton
                icon={Pin}
                title="Pin: keep this skin shown together with whichever skin is chosen next (a preview, the export does not change)"
                small
                active={skinPins.includes(s.id)}
                onClick={(e) => (e.stopPropagation(), toggleSkinPin(s.id))}
              />
            )}
            {i > 0 && s !== current && (
              <IconButton
                icon={Layers}
                title="Show together with the chosen skin (a preview of skins worn at once; its attachments replace the earlier ones, the export does not change)"
                small
                active={skinMix.includes(s.id)}
                onClick={(e) => (e.stopPropagation(), toggleSkinMix(s.id))}
              />
            )}
            {i > 0 && (
              <span className="actions">
                <IconButton icon={Pencil} title="Rename skin" small onClick={(e) => (e.stopPropagation(), setRenaming(s.id))} />
                <IconButton icon={Trash2} title="Delete skin" small onClick={(e) => (e.stopPropagation(), deleteSkin(s.id))} />
              </span>
            )}
          </div>
        ))}

        <div className="section-label">Attachments</div>
        {isDefault ? (
          <div className="hint-text skin-hint">
            The default skin holds every attachment. Pick another skin to choose which attachments it replaces with its own copy.
          </div>
        ) : (
          <>
            <div className="hint-text skin-hint">
              Filled: this skin has its own copy. Click to make one, or to go back to the default skin's.
            </div>
            {slots.length === 0 && <div className="empty">No attachments yet.</div>}
            {slots.map((slot) => (
              <div key={slot.id} className="skin-slot">
                <span className="skin-slot-name">{slot.name}</span>
                <span className="skin-chips">
                  {Object.keys(defaultSkin.attachments[slot.id]).map((name) => {
                    const own = overrideState(doc, current.id, slot.id, name) === 'own';
                    return (
                      <button
                        key={name}
                        type="button"
                        className={`chip skin-chip${own ? ' own' : ''}`}
                        data-tip={
                          own ? 'Own copy in this skin. Click to use the default one' : 'From the default skin. Click to make an own copy'
                        }
                        onClick={() => toggleSkinOverride(current.id, slot.id, name)}
                      >
                        {name}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </>
        )}

        <div className="section-label">Scope: bones</div>
        <div className="hint-text skin-hint">
          Lock a bone to make it exist only in the skins you tick (a hat, a second tail). The bones above it stay active.
        </div>
        {bones.map(({ bone, depth }) => (
          <ScopeRow
            key={bone.id}
            kind="bone"
            id={bone.id}
            name={bone.name}
            depth={depth}
            icon={<BoneIcon size={13} />}
            required={requiredBones.has(bone.id)}
            inSkin={!!skin?.bones.includes(bone.id)}
            skin={skin}
          />
        ))}

        {doc.constraints.length > 0 && <div className="section-label">Scope: constraints</div>}
        {doc.constraints.map((c) => (
          <ScopeRow
            key={c.id}
            kind="constraint"
            id={c.id}
            name={c.name}
            icon={constraintIcon(c)}
            required={c.skinRequired}
            inSkin={!!skin?.constraints.includes(c.id)}
            skin={skin}
          />
        ))}
      </div>
    </div>
  );
}
