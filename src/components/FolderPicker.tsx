import { FileUp, FolderInput } from 'lucide-react';
import { useTranslation } from '../i18n';
import { Button } from './Button';

interface FolderPickerProps {
  directorySupported: boolean;
  fileSupported: boolean;
  onPickDirectory: () => void;
  onPickFile: () => void;
  busy?: boolean;
  detail?: string;
}

export function FolderPicker({
  directorySupported,
  fileSupported,
  onPickDirectory,
  onPickFile,
  busy,
  detail,
}: FolderPickerProps) {
  const { t } = useTranslation();

  return (
    <section className="rounded border border-slate-800 bg-slate-950/70 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-100">
          {t('folderPicker.title')}
        </h2>
        <p className="text-sm text-slate-400">
          {t('folderPicker.description')}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={onPickDirectory}
          disabled={busy || !directorySupported}
        >
          <FolderInput className="h-4 w-4" aria-hidden="true" />
          {directorySupported
            ? t('folderPicker.openSupported')
            : t('folderPicker.openUnsupported')}
        </Button>
        <Button onClick={onPickFile} disabled={busy || !fileSupported}>
          <FileUp className="h-4 w-4" aria-hidden="true" />
          {t('folderPicker.openFile')}
        </Button>
      </div>
      <div className="mt-3 space-y-1">
        <p className="text-sm text-slate-400">{t('folderPicker.detail')}</p>
        {detail ? <p className="text-xs text-slate-400">{detail}</p> : null}
        {!directorySupported ? (
          <p className="text-xs text-amber-300">
            {t('folderPicker.unsupportedHint')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
