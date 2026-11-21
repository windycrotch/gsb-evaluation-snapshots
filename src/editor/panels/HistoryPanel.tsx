import { useEffect, useState } from 'react';
import { ArchiveRestore, CircleDot, DatabaseBackup, Trash2, Undo2 } from 'lucide-react';
import type { BackupWhy } from '@/core/backups';
import { deleteBackup, refreshBackups, useBackups } from '@/store/backups';
import { docStore } from '@/store/doc';
import { backupCurrent, restoreBackup } from '@/store/project';
import { toast } from '@/store/ui';
import { IconButton } from '../ui/controls';
import { Checkpoints } from './Checkpoints';

const WHY: Record<BackupWhy, string> = {
  auto: 'Automatic',
  manual: 'Saved by hand',
  open: 'Before opening another file',
  new: 'Before a new project',
  restore: 'Before a restore',
};

/** The backups kept in the browser, newest first: take one by hand, bring one back (what is open is backed up first), delete one. */
function Backups() {
  const list = useBackups();
  useEffect(() => void refreshBackups(), []);
  return (
    <>
      <div className="section-label">Backups</div>
      <div className="row">
        <span className="ico">
          <DatabaseBackup size={12} />
        </span>
        <span className="label dim" title="Copies of the project kept in this browser">
          Kept in this browser
        </span>
        <span className="actions pinned">
          <IconButton
            icon={DatabaseBackup}
            title="Back up now"
            small
            onClick={() => void backupCurrent('manual').then((ok) => toast(ok ? 'Backup saved' : 'Nothing to back up', ok ? 'ok' : 'info'))}
          />
        </span>
      </div>
      {list.map((b) => (
        <div key={b.id} className="row" title={new Date(b.time).toLocaleString()}>
          <span className="ico">
            <CircleDot size={12} />
          </span>
          <span className="label">
            {new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} <span className="dim">{WHY[b.why]}</span>
          </span>
          <span className="row-meta" data-tip="bones / animations">
            {b.bones}/{b.animations}
          </span>
          <span className="actions">
            <IconButton icon={ArchiveRestore} title="Restore this backup" small onClick={() => void restoreBackup(b.id)} />
            <IconButton icon={Trash2} title="Delete this backup" small onClick={() => void deleteBackup(b.id)} />
          </span>
        </div>
      ))}
    </>
  );
}

/** The History window: every step that can be undone, and the ones that were undone; a click goes to that point. Spine has only Ctrl+Z. */
export function HistoryPanel() {
  const [, force] = useState(0);
  useEffect(() => {
    const stop = docStore.subscribe(() => force((n) => n + 1));
    return () => void stop();
  }, []);
  const { past, future } = docStore.history;
  return (
    <div className="panel grow" style={{ minHeight: 110 }}>
      <div className="panel-head">
        <span className="title">History</span>
        <IconButton icon={Undo2} title="Undo" small disabled={!docStore.canUndo} onClick={() => docStore.undo()} />
      </div>
      <div className="panel-body">
        <div className="row" onClick={() => docStore.jumpTo(-1)}>
          <span className="ico">
            <CircleDot size={12} />
          </span>
          <span className="label dim">Opened</span>
        </div>
        {past.map((label, i) => (
          <div key={`p${i}`} className={`row${i === past.length - 1 ? ' selected' : ''}`} onClick={() => docStore.jumpTo(i)}>
            <span className="ico row-meta">{i + 1}</span>
            <span className="label">{label}</span>
          </div>
        ))}
        {future.map((label, i) => (
          <div key={`f${i}`} className="row undone" onClick={() => docStore.jumpTo(past.length + i)}>
            <span className="ico row-meta">{past.length + i + 1}</span>
            <span className="label">{label}</span>
          </div>
        ))}
        <Checkpoints />
        <Backups />
      </div>
    </div>
  );
}
