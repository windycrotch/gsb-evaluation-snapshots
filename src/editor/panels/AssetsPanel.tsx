import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  Film,
  Folder,
  FolderUp,
  Grid3x3,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { baseOf, imageGroups, imageUsage } from '@/core/images';
import { skeletonList } from '@/core/skeletons';
import type { ImageRef } from '@/core/model';
import {
  addImageToScene,
  importDropped,
  importFolderFiles,
  importImageFiles,
  reimportPsd,
  removeUnusedImages,
  renameImageAction,
  replaceImagePixels,
} from '@/store/actions';
import { assets } from '@/store/assets';
import { docStore, useProject } from '@/store/doc';
import { canReadGif, importGif } from '@/store/frameImport';
import { openSliceDialog } from '@/store/sliceDialog';
import { toast, uiStore } from '@/store/ui';
import { IconButton, Menu, MenuItem } from '../ui/controls';

function Thumb({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const version = assets.get(name)?.version;
  useEffect(() => {
    const a = assets.get(name);
    if (!a) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(a.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [name, version]);
  return url ? <img className="thumb" src={url} draggable={false} alt={name} /> : <div className="thumb" />;
}

/**
 * The Images window: the pictures of the project in folders (the part of a name before the last "/"), with rename (attachments follow),
 * replace (new pixels under the same name), the ones nothing shows marked, and a button that removes them.
 */
export function AssetsPanel() {
  const project = useProject();
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const psdRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const gifRef = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const uses = useMemo(() => {
    // the pictures are shared by every skeleton of the project: one that another skeleton shows is in use
    const all = new Map<string, number>();
    for (const doc of skeletonList(project)) for (const [name, n] of imageUsage(doc)) all.set(name, (all.get(name) ?? 0) + n);
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `project` changes with every edit; these two are what the count depends on
  }, [project.skeleton, project.others]);
  const byName = useMemo(() => new Map(project.images.map((i) => [i.name, i] as const)), [project.images]);
  const groups = useMemo(() => imageGroups(project.images.map((i) => i.name)), [project.images]);
  const unused = project.images.filter((i) => !uses.has(i.name)).length;

  const removeImage = (name: string) => {
    if (uses.has(name)) {
      toast(`"${name}" is used by an attachment`, 'error');
      return;
    }
    docStore.update('Remove image', (d) => {
      d.images = d.images.filter((i) => i.name !== name);
    });
  };

  const tile = (img: ImageRef) => {
    const used = uses.get(img.name) ?? 0;
    return (
      <div
        key={img.id}
        className={`asset${used === 0 ? ' unused' : ''}`}
        draggable={renaming !== img.name}
        data-tip={`${img.name} — drag into the viewport, or double-click to add at the center${used === 0 ? ' · no attachment shows this image' : ''}`}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-bone2d-image', img.name);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onDoubleClick={() => {
          if (renaming) return;
          const cam = uiStore.get().camera;
          addImageToScene(img.name, cam.x, cam.y);
        }}
      >
        <Thumb name={img.name} />
        {renaming === img.name ? (
          <input
            className="asset-rename"
            autoFocus
            defaultValue={img.name}
            aria-label="Image name"
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              renameImageAction(img.name, e.target.value);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') setRenaming(null);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="name">{baseOf(img.name)}</span>
        )}
        <span className="dim">
          {img.width}×{img.height}
          {used === 0 ? ' · unused' : ''}
        </span>
        <span className="asset-actions">
          <IconButton
            icon={Grid3x3}
            title="Cut into frames: a sprite sheet becomes numbered pictures that play as a sequence"
            small
            onClick={(e) => (e.stopPropagation(), openSliceDialog(img.name))}
          />
          <IconButton
            icon={Pencil}
            title="Rename image (a / in the name makes a folder)"
            small
            onClick={(e) => (e.stopPropagation(), setRenaming(img.name))}
          />
          <IconButton
            icon={Upload}
            title="Replace the picture, keep the name"
            small
            onClick={(e) => {
              e.stopPropagation();
              replacing.current = img.name;
              replaceRef.current?.click();
            }}
          />
          <IconButton icon={Trash2} title="Remove image" small onClick={(e) => (e.stopPropagation(), removeImage(img.name))} />
        </span>
      </div>
    );
  };

  return (
    <div className="panel" style={{ height: 260 }} data-learn="images">
      <div className="panel-head">
        <span className="title">Images</span>

        <IconButton
          icon={ImagePlus}
          title="Import images (or a PSD file: every layer becomes a picture and a slot)"
          small
          onClick={() => fileRef.current?.click()}
        />
        <Menu icon={MoreHorizontal} label="" title="More ways to bring pictures in, and cleaning up">
          {(close) => (
            <>
              <MenuItem
                icon={FolderUp}
                close={close}
                onClick={() => folderRef.current?.click()}
                title="Import a folder of images (its folders become folders of pictures)"
              >
                Import a folder
              </MenuItem>
              <MenuItem
                icon={Film}
                close={close}
                disabled={!canReadGif()}
                onClick={() => gifRef.current?.click()}
                title={
                  canReadGif()
                    ? 'Import an animated GIF: every frame becomes a picture, played as a sequence'
                    : 'This browser cannot take a GIF apart: cut a sprite sheet instead'
                }
              >
                Import an animated GIF
              </MenuItem>
              <MenuItem
                icon={RefreshCw}
                close={close}
                disabled={project.images.length === 0}
                onClick={() => psdRef.current?.click()}
                title="Layers with the name of a picture give it new pixels, new layers become slots"
              >
                Update from PSD
              </MenuItem>
              <MenuItem
                icon={Eraser}
                close={close}
                disabled={unused === 0}
                onClick={() => removeUnusedImages()}
                title="Remove the images no attachment shows"
              >
                Remove unused images
              </MenuItem>
            </>
          )}
        </Menu>

        <input
          ref={folderRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error not in the React typings: lets the browser choose a folder
          webkitdirectory=""
          onChange={async (e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = '';
            await importFolderFiles(list);
          }}
        />

        <input
          ref={gifRef}
          type="file"
          accept=".gif,image/gif"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) await importGif(file, { scene: true });
          }}
        />

        <input
          ref={psdRef}
          type="file"
          accept=".psd"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) await reimportPsd(file);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.psd"
          multiple
          hidden
          onChange={async (e) => (await importImageFiles([...(e.target.files ?? [])]), (e.target.value = ''))}
        />
        <input
          ref={replaceRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            const name = replacing.current;
            e.target.value = '';
            if (file && name) await replaceImagePixels(name, file);
          }}
        />
      </div>
      <div
        className="panel-body"
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={async (e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          await importDropped(e.dataTransfer);
        }}
      >
        {project.images.length === 0 ? (
          <div className="drop-hint" onClick={() => fileRef.current?.click()}>
            Drop PNG / WebP images, a folder of them or a PSD file here
            <br />
            or click to browse
          </div>
        ) : (
          groups.map(([folder, names]) => (
            <div key={folder || '/'}>
              {folder !== '' && (
                <div className="row folder" onClick={() => setClosed({ ...closed, [folder]: !closed[folder] })}>
                  <span className="chev">{closed[folder] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
                  <span className="ico">
                    <Folder size={13} />
                  </span>
                  <span className="label">{folder}</span>
                  <span className="dim row-meta">{names.length}</span>
                </div>
              )}
              {!closed[folder] && (
                <div className="asset-grid">
                  {names
                    .map((n) => byName.get(n))
                    .filter((i): i is ImageRef => !!i)
                    .map(tile)}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
