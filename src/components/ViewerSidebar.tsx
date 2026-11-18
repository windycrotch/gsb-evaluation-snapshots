import {
  ArrowLeft,
  Box,
  Contrast,
  Crosshair,
  FolderInput,
  Languages,
  ListVideo,
  RotateCcw,
  SlidersHorizontal,
  SunMedium,
} from 'lucide-react';
import { formatSpacing } from '../app/helpers';
import { useTranslation } from '../i18n';
import type {
  ImportIssue,
  ImportProgress,
  LoadedVolume,
  RangeBounds,
  SliceWindowLevel,
  Vec3,
  VolumeCursor,
  VolumeSeriesChoice,
} from '../types';
import { Button } from './Button';
import { ImportStatus, ImportStatusStage } from './ImportStatus';
import { LanguageSelect } from './LanguageSelect';
import { Notice } from './Notice';
import { RangeField } from './RangeField';

interface ViewerSidebarProps {
  id?: string;
  cursor: VolumeCursor | null;
  dimensions: Vec3;
  downsampled3D: boolean;
  issue: ImportIssue | null;
  levelBounds: RangeBounds;
  mprZoom: number;
  progress: ImportProgress;
  selectedSeriesId: string;
  seriesChoices: VolumeSeriesChoice[];
  sourceLabel: string;
  spacing: Vec3;
  volume: LoadedVolume | null;
  windowBounds: RangeBounds;
  windowLevelDraft: SliceWindowLevel;
  onBackToImport: () => void;
  onLevelChange: (value: number) => void;
  onLevelCommit: (value: number) => void;
  onOpenDirectory: () => void;
  onResetMprZoom: () => void;
  onSeriesChange: (seriesId: string) => void;
  onWindowChange: (value: number) => void;
  onWindowCommit: (value: number) => void;
}

export function ViewerSidebar({
  id,
  cursor,
  dimensions,
  downsampled3D,
  issue,
  levelBounds,
  mprZoom,
  progress,
  selectedSeriesId,
  seriesChoices,
  sourceLabel,
  spacing,
  volume,
  windowBounds,
  windowLevelDraft,
  onBackToImport,
  onLevelChange,
  onLevelCommit,
  onOpenDirectory,
  onResetMprZoom,
  onSeriesChange,
  onWindowChange,
  onWindowCommit,
}: ViewerSidebarProps) {
  const { t } = useTranslation();
  const sectionLabelClass =
    'inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-slate-400';
  const selectedSeries = seriesChoices.find(
    (choice) => choice.id === selectedSeriesId,
  );
  const sparseCrossPlane =
    spacing[2] > Math.max(spacing[0], spacing[1], 0.001) * 3;

  return (
    <aside
      id={id}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <section className="shrink-0 min-w-0 rounded border border-slate-800 bg-slate-950/75 px-2.5 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className={sectionLabelClass}>
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            {t('common.language')}
          </div>
          <LanguageSelect floating={false} />
        </div>
      </section>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
        <section className="min-w-0 rounded border border-slate-800 bg-slate-950/80 p-2.5">
          <div className={sectionLabelClass}>
            <Box className="h-3.5 w-3.5" aria-hidden="true" />
            {t('viewerSidebar.study')}
          </div>
          <div
            className="mt-1 truncate text-sm font-semibold text-slate-100"
            title={volume?.meta.scanId}
          >
            {volume?.meta.scanId}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {volume?.meta.formatLabel}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {t('viewerSidebar.voxelsLabel', {
              dimensions: dimensions.join(' x '),
            })}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {t('viewerSidebar.spacingLabel', {
              spacing: formatSpacing(spacing),
            })}
          </div>
          {seriesChoices.length > 1 ? (
            <label className="mt-2 block">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
                <ListVideo className="h-3.5 w-3.5" aria-hidden="true" />
                {t('viewerSidebar.series')}
              </span>
              <select
                className="app-control mt-1 min-h-10 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-base text-slate-100 motion-safe:transition-colors focus-visible:border-cyan-400 sm:text-xs"
                value={selectedSeriesId}
                onChange={(event) => onSeriesChange(event.target.value)}
              >
                {seriesChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {selectedSeries ? (
                <span className="mt-1 block text-xs text-slate-400">
                  {selectedSeries.detail}
                </span>
              ) : null}
              {sparseCrossPlane ? (
                <span className="mt-1 block text-xs text-amber-300/80">
                  {t('viewerSidebar.thickSliceHint')}
                </span>
              ) : null}
            </label>
          ) : null}
          <div
            className="mt-1 truncate text-xs text-slate-400"
            title={sourceLabel}
          >
            {sourceLabel}
          </div>
        </section>

        <section className="min-w-0 rounded border border-slate-800 bg-slate-950/70 p-2.5">
          <div className={sectionLabelClass}>
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            {t('viewerSidebar.display')}
          </div>
          <div className="mt-2.5">
            <RangeField
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Contrast className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewerSidebar.window')}
                </span>
              }
              min={windowBounds.min}
              max={windowBounds.max}
              value={windowLevelDraft.window}
              onChange={onWindowChange}
              onCommit={onWindowCommit}
              hint={t('viewerSidebar.windowHint')}
            />
          </div>

          <div className="mt-2.5">
            <RangeField
              label={
                <span className="inline-flex items-center gap-1.5">
                  <SunMedium className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewerSidebar.level')}
                </span>
              }
              min={levelBounds.min}
              max={levelBounds.max}
              value={windowLevelDraft.level}
              onChange={onLevelChange}
              onCommit={onLevelCommit}
              hint={t('viewerSidebar.levelHint')}
            />
          </div>
        </section>

        <div className="min-h-0 min-w-0">
          <ImportStatus
            progress={progress}
            issue={issue}
            stage={ImportStatusStage.Viewer}
          />
        </div>

        <section className="min-w-0 rounded border border-slate-800 bg-slate-950/70 p-2.5">
          <div className={sectionLabelClass}>
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {t('viewerSidebar.navigation')}
          </div>
          <div className="mt-2 text-xs text-slate-400">
            {t('viewerSidebar.cursor')}{' '}
            {cursor
              ? `${cursor.x + 1}, ${cursor.y + 1}, ${cursor.z + 1}`
              : t('viewerSidebar.cursorUnavailable')}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            disabled={mprZoom === 1}
            onClick={onResetMprZoom}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('axisViewport.resetZoom')}
          </Button>
          <div className="mt-3 text-xs font-medium text-slate-300">
            {t('viewerSidebar.navigationHelp')}
          </div>
          <div className="mt-1 space-y-1 text-xs text-slate-400">
            <p>{t('viewerSidebar.dragHint')}</p>
            <p>{t('viewerSidebar.zoomHint')}</p>
            <p>{t('viewerSidebar.keyboardHint')}</p>
            <p>{t('viewerSidebar.orientationHint')}</p>
            <p className="pt-1 text-slate-300">
              {t('viewerSidebar.volumeSection')}
            </p>
            <p>
              {downsampled3D
                ? t('viewerSidebar.volumeDownsampled')
                : t('viewerSidebar.volumeNative')}
            </p>
            <p>{t('viewerSidebar.planeHint')}</p>
          </div>
        </section>
      </div>

      <section className="shrink-0 min-w-0 rounded border border-slate-800 bg-slate-950/70 p-2.5">
        <div className="grid grid-cols-1 gap-2">
          <Button variant="primary" block onClick={onOpenDirectory}>
            <FolderInput className="h-4 w-4" aria-hidden="true" />
            {t('viewerSidebar.openFolder')}
          </Button>
          <Button variant="ghost" block onClick={onBackToImport}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('viewerSidebar.backToImport')}
          </Button>
        </div>
        <Notice className="mt-3" compact>
          {t('common.referenceOnly')}
        </Notice>
      </section>
    </aside>
  );
}
