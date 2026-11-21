/** The "cut into frames" dialog: a sprite sheet is cut along a grid into numbered pictures that play as a sequence. */
import { useEffect, useMemo, useState } from 'react';
import { delayForFps, gridByCell, gridByCount } from '@/core/spritesheet';
import { baseOf } from '@/core/images';
import { assets } from '@/store/assets';
import { useProject } from '@/store/doc';
import { sliceSpriteSheet } from '@/store/frameImport';
import { closeSliceDialog, useSliceDialog } from '@/store/sliceDialog';
import { Button, Dialog, NumberField, SelectField, TextField, Toggle } from '../ui/controls';
import { Field } from '../ui/Field';

type By = 'count' | 'cell';

/** Where the dialog is mounted: renders nothing while no picture is being cut. */
export function SliceDialogHost() {
  const image = useSliceDialog();
  return image ? <SliceDialog image={image} /> : null;
}

function SliceDialog({ image }: { image: string }) {
  const project = useProject();
  const ref = project.images.find((i) => i.name === image);
  const [by, setBy] = useState<By>('count');
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(1);
  const [cellW, setCellW] = useState(ref ? Math.max(1, Math.floor(ref.width / 4)) : 32);
  const [cellH, setCellH] = useState(ref ? ref.height : 32);
  const [margin, setMargin] = useState(0);
  const [spacing, setSpacing] = useState(0);
  const [byColumns, setByColumns] = useState(false);
  const [dropBlank, setDropBlank] = useState(true);
  const [scene, setScene] = useState(true);
  const [fps, setFps] = useState(12);
  const [name, setName] = useState(baseOf(image));
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const a = assets.get(image);
    if (!a) return;
    const u = URL.createObjectURL(a.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);

  const grid = useMemo(
    () =>
      ref
        ? by === 'count'
          ? gridByCount(ref.width, ref.height, cols, rows, margin, spacing)
          : gridByCell(ref.width, ref.height, cellW, cellH, margin, spacing)
        : null,
    [ref, by, cols, rows, cellW, cellH, margin, spacing],
  );
  if (!ref) {
    return (
      <Dialog title="Cut into frames" onClose={closeSliceDialog}>
        <p className="hint-text">This picture no longer exists.</p>
      </Dialog>
    );
  }

  const go = async () => {
    if (!grid || busy) return;
    setBusy(true);
    try {
      const made = await sliceSpriteSheet(image, { grid, byColumns, dropBlank, base: name, scene, delay: delayForFps(fps) });
      if (made > 0) closeSliceDialog();
    } finally {
      setBusy(false);
    }
  };

  const lines: number[][] = [];
  if (grid) {
    for (let c = 0; c < grid.cols; c++) {
      const x = grid.margin + c * (grid.cellW + grid.spacing);
      lines.push([x, 0, x, ref.height], [x + grid.cellW, 0, x + grid.cellW, ref.height]);
    }
    for (let r = 0; r < grid.rows; r++) {
      const y = grid.margin + r * (grid.cellH + grid.spacing);
      lines.push([0, y, ref.width, y], [0, y + grid.cellH, ref.width, y + grid.cellH]);
    }
  }

  return (
    <Dialog
      title="Cut into frames"
      onClose={closeSliceDialog}
      width={460}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={closeSliceDialog}>Cancel</Button>
          <Button primary onClick={go}>
            Cut
          </Button>
        </>
      }
    >
      <p className="hint-text mb">
        A picture with the frames of an animation in a grid is cut into numbered pictures that play as a sequence.
      </p>
      <div className="slice-preview" style={{ position: 'relative', marginBottom: 8, maxHeight: 180, overflow: 'hidden' }}>
        {url && (
          <img src={url} alt={image} draggable={false} style={{ display: 'block', maxWidth: '100%', maxHeight: 180, margin: '0 auto' }} />
        )}
        {url && grid && (
          <svg
            viewBox={`0 0 ${ref.width} ${ref.height}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {lines.map((l, i) => (
              <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="var(--accent)" strokeWidth={Math.max(1, ref.width / 300)} />
            ))}
          </svg>
        )}
      </div>
      <Field label="Cut by" title="Give the number of columns and rows, or the size of a cell">
        <SelectField<By>
          value={by}
          options={[
            { value: 'count', label: 'Columns and rows' },
            { value: 'cell', label: 'Cell size' },
          ]}
          onChange={setBy}
        />
      </Field>
      {by === 'count' ? (
        <>
          <Field label="Columns">
            <NumberField label="c" value={cols} step={1} precision={0} min={1} max={500} onChange={(v) => setCols(Math.round(v))} />
          </Field>
          <Field label="Rows">
            <NumberField label="r" value={rows} step={1} precision={0} min={1} max={500} onChange={(v) => setRows(Math.round(v))} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Cell width" title="Width of one frame, in pixels">
            <NumberField label="w" value={cellW} step={1} precision={0} min={1} onChange={(v) => setCellW(Math.round(v))} />
          </Field>
          <Field label="Cell height" title="Height of one frame, in pixels">
            <NumberField label="h" value={cellH} step={1} precision={0} min={1} onChange={(v) => setCellH(Math.round(v))} />
          </Field>
        </>
      )}
      <Field label="Margin" title="Empty border around the grid, in pixels">
        <NumberField label="px" value={margin} step={1} precision={0} min={0} onChange={(v) => setMargin(Math.round(v))} />
      </Field>
      <Field label="Spacing" title="Empty gap between two cells, in pixels">
        <NumberField label="px" value={spacing} step={1} precision={0} min={0} onChange={(v) => setSpacing(Math.round(v))} />
      </Field>
      <Field label="Order" title="The order the frames are numbered in">
        <SelectField<'rows' | 'columns'>
          value={byColumns ? 'columns' : 'rows'}
          options={[
            { value: 'rows', label: 'Along the rows' },
            { value: 'columns', label: 'Down the columns' },
          ]}
          onChange={(v) => setByColumns(v === 'columns')}
        />
      </Field>
      <Field label="Name" title="The start of the names of the pictures: name01, name02 …">
        <TextField value={name} onCommit={setName} wide />
      </Field>
      <Field label="Skip empty" title="Leave out the empty cells at the end of the sheet (the unused rest of the last row)">
        <Toggle on={dropBlank} onChange={setDropBlank} title="Skip the empty cells at the end" />
      </Field>
      <Field label="On the scene" title="Put the frames on the scene as a slot that plays them">
        <Toggle on={scene} onChange={setScene} title="Put the frames on the scene as a sequence" />
      </Field>
      {scene && (
        <Field label="Frame rate" title="Frames per second; the sequence loops at this speed from the start of the open animation">
          <NumberField label="fps" value={fps} step={1} precision={0} min={1} max={240} onChange={(v) => setFps(Math.round(v))} />
        </Field>
      )}
      <p className="hint-text">
        {grid ? `${grid.cols}×${grid.rows} cells of ${grid.cellW}×${grid.cellH} px` : 'The cells do not fit in the picture'}
      </p>
    </Dialog>
  );
}
