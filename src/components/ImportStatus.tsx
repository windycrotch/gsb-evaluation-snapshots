import { CircleCheck } from 'lucide-react';
import { useTranslation } from '../i18n';
import { type ImportIssue, type ImportProgress, ImportStage } from '../types';
import { cn } from '../utils/cn';

export enum ImportStatusStage {
  Import = 'import',
  Viewer = 'viewer',
}

interface ImportStatusProps {
  progress: ImportProgress;
  issue?: ImportIssue | null;
  stage?: ImportStatusStage;
}

function resolveProgressPercent(progress: ImportProgress): number {
  const local = progress.total > 0 ? progress.completed / progress.total : 0;

  switch (progress.stage) {
    case ImportStage.Idle:
      return 0;
    case ImportStage.Scanning:
      return 4 + local * 4;
    case ImportStage.ParsingMeta:
      return 8 + local * 10;
    case ImportStage.Assembling:
      return 18 + local * 8;
    case ImportStage.InflatingSlices:
      return 26 + local * 54;
    case ImportStage.Preparing3D:
      return 80 + local * 20;
    case ImportStage.Ready:
      return 100;
    case ImportStage.Error:
      return Math.max(8, Math.min(99, local * 100));
    default:
      return local * 100;
  }
}

export function ImportStatus({
  progress,
  issue,
  stage = ImportStatusStage.Import,
}: ImportStatusProps) {
  const { t } = useTranslation();
  const pct = Math.round(resolveProgressPercent(progress));
  const detail = t(progress.detailKey, progress.detailValues);
  const issueText = issue ? t(issue.messageKey) : undefined;
  const stageLabelKey: Record<ImportStage, string> = {
    [ImportStage.Idle]: 'importStatus.stages.idle',
    [ImportStage.Scanning]: 'importStatus.stages.scanning',
    [ImportStage.ParsingMeta]: 'importStatus.stages.parsingMeta',
    [ImportStage.InflatingSlices]: 'importStatus.stages.inflatingSlices',
    [ImportStage.Assembling]: 'importStatus.stages.assembling',
    [ImportStage.Preparing3D]: 'importStatus.stages.preparing3D',
    [ImportStage.Ready]: 'importStatus.stages.ready',
    [ImportStage.Error]: 'importStatus.stages.error',
  };
  const stageLabel = t(stageLabelKey[progress.stage]);
  const busy = ![
    ImportStage.Idle,
    ImportStage.Ready,
    ImportStage.Error,
  ].includes(progress.stage);

  if (
    stage === ImportStatusStage.Viewer &&
    progress.stage === ImportStage.Ready
  ) {
    return (
      <div
        className="flex min-h-10 items-center gap-2 rounded border border-emerald-500/25 bg-emerald-500/8 px-2.5 py-2 text-xs"
        role="status"
      >
        <CircleCheck
          className="h-4 w-4 shrink-0 text-emerald-300"
          aria-hidden="true"
        />
        <strong className="min-w-0 flex-1 truncate font-medium text-slate-100">
          {detail}
        </strong>
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-400">
          {stageLabel}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        'rounded border border-slate-800 bg-slate-950/70 p-3',
        stage === ImportStatusStage.Viewer ? 'text-xs' : '',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="truncate text-sm font-medium text-slate-100">
          {detail}
        </strong>
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-400">
          {stageLabel}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label={t('importStatus.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={t('importStatus.progressValue', {
          stage: stageLabel,
          percent: pct,
        })}
      >
        <span
          className="block h-full rounded-full bg-sky-400 motion-safe:transition-[width]"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="mt-2 flex items-start justify-between gap-3">
        <span className="text-xs text-slate-400">
          {progress.completed}/{progress.total || 0}
        </span>
        {issueText ? (
          <span
            className={cn(
              'text-right text-xs',
              progress.stage === ImportStage.Error
                ? 'text-red-300'
                : 'text-amber-300',
            )}
          >
            {issueText}
          </span>
        ) : null}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {stageLabel}
      </span>
    </div>
  );
}
