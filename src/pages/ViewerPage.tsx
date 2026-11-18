import { Box, PanelRightClose } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ViewerApp } from '../app/useViewerApp';
import { useCompactViewerLayout } from '../app/viewer-layout';
import { AxisViewportGrid } from '../components/AxisViewportGrid';
import { Button } from '../components/Button';
import { ViewerSidebar } from '../components/ViewerSidebar';
import { ViewportFrame } from '../components/ViewportFrame';
import { VolumeViewport3D } from '../components/VolumeViewport3D';
import { useTranslation } from '../i18n';
import { cn } from '../utils/cn';

interface ViewerPageProps {
  app: ViewerApp;
}

const AXIS_VIEWS_ID = 'mpr-viewports';
const STUDY_PANEL_ID = 'viewer-study-panel';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0);
}

export default function ViewerPage({ app }: ViewerPageProps) {
  const compactLayout = useCompactViewerLayout();
  const [compactDrawerOpen, setCompactDrawerOpen] = useState(false);
  const viewerContentRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const { t } = useTranslation();
  const studyPanelVisible = compactLayout
    ? compactDrawerOpen
    : app.sidebarVisible;

  useEffect(() => {
    if (compactLayout) setCompactDrawerOpen(false);
  }, [compactLayout]);

  useEffect(() => {
    const background = viewerContentRef.current;
    if (!background) return undefined;

    if (!compactLayout || !compactDrawerOpen) {
      background.inert = false;
      return undefined;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    background.inert = true;
    const frame = window.requestAnimationFrame(() => {
      getFocusableElements(dialogRef.current ?? document.body)[0]?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      background.inert = false;
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [compactDrawerOpen, compactLayout]);

  const setStudyPanelVisible = (visible: boolean) => {
    if (compactLayout) {
      setCompactDrawerOpen(visible);
      return;
    }
    app.setSidebarVisible(visible);
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setCompactDrawerOpen(false);
      return;
    }

    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = getFocusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!app.volume) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
        <h1 className="sr-only">{t('viewerPage.title')}</h1>
        <div className="rounded border border-slate-800 bg-slate-950/90 px-4 py-3 text-sm text-slate-400">
          {t('viewerPage.loading')}
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen overflow-hidden bg-slate-950 text-slate-100">
      <h1 className="sr-only">{t('viewerPage.title')}</h1>
      <div className="relative h-full overflow-hidden bg-slate-800">
        <div
          ref={viewerContentRef}
          className={cn(
            'grid h-full gap-px',
            compactLayout
              ? 'grid-cols-1'
              : app.sidebarVisible
                ? 'grid-cols-[minmax(0,1fr)_minmax(288px,22vw)]'
                : 'grid-cols-1',
          )}
        >
          <section className="min-h-0 min-w-0">
            <div
              className={cn(
                'grid h-full min-h-0 min-w-0 gap-px bg-slate-800',
                app.axisViewsVisible
                  ? compactLayout
                    ? 'grid-rows-[minmax(0,1.1fr)_minmax(260px,0.9fr)]'
                    : 'grid-rows-[1.22fr_0.95fr]'
                  : 'grid-rows-1',
              )}
            >
              <div className="grid min-h-0 min-w-0 grid-cols-1 gap-px bg-slate-800">
                <ViewportFrame
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      <Box
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                      />
                      3D
                    </span>
                  }
                  subtitle={t('viewerPage.mainNavigationVolume')}
                  status={
                    app.prepared3D
                      ? app.prepared3D.downsampled
                        ? t('viewerPage.downsampledStatus')
                        : t('viewerPage.nativeStatus')
                      : t('viewerPage.preparingStatus')
                  }
                >
                  <VolumeViewport3D
                    volume={app.prepared3D}
                    cursor={app.cursor}
                    axisViewsVisible={app.axisViewsVisible}
                    onAxisViewsVisibleChange={app.setAxisViewsVisible}
                    sidebarVisible={studyPanelVisible}
                    onSidebarVisibleChange={setStudyPanelVisible}
                    onDownsampledChange={app.setDownsampled3D}
                    axisViewsControlsId={AXIS_VIEWS_ID}
                    sidebarControlsId={STUDY_PANEL_ID}
                  />
                </ViewportFrame>
              </div>

              {app.axisViewsVisible ? (
                <AxisViewportGrid
                  id={AXIS_VIEWS_ID}
                  compact={compactLayout}
                  volume={app.volume}
                  cursor={app.cursor}
                  dimensions={app.dimensions}
                  slices={app.slices}
                  mprZoom={app.mprZoom}
                  selectedAxis={app.selectedAxis}
                  onZoomChange={app.setMprZoom}
                  onSelectedAxisChange={app.setSelectedAxis}
                  onSelectAxis={app.updateCursor}
                />
              ) : null}
            </div>
          </section>

          {!compactLayout && app.sidebarVisible ? (
            <ViewerSidebar
              id={STUDY_PANEL_ID}
              volume={app.volume}
              sourceLabel={app.sourceLabel}
              dimensions={app.dimensions}
              spacing={app.spacing}
              windowBounds={app.windowBounds}
              levelBounds={app.levelBounds}
              mprZoom={app.mprZoom}
              windowLevelDraft={app.windowLevelDraft}
              progress={app.progress}
              issue={app.issue}
              cursor={app.cursor}
              downsampled3D={app.downsampled3D}
              selectedSeriesId={app.selectedSeriesId}
              seriesChoices={app.seriesChoices}
              onWindowChange={app.handleWindowChange}
              onWindowCommit={app.handleWindowCommit}
              onLevelChange={app.handleLevelChange}
              onLevelCommit={app.handleLevelCommit}
              onResetMprZoom={() => app.setMprZoom(1)}
              onSeriesChange={(seriesId) => void app.selectSeries(seriesId)}
              onOpenDirectory={() => void app.openDirectory()}
              onBackToImport={app.resetViewer}
            />
          ) : null}
        </div>

        {compactLayout && compactDrawerOpen ? (
          <div className="absolute inset-0 z-40 flex justify-end">
            <div
              className="absolute inset-0 bg-slate-950/60 backdrop-blur-[1px]"
              aria-hidden="true"
              onClick={() => setCompactDrawerOpen(false)}
            />
            <section
              ref={dialogRef}
              id={STUDY_PANEL_ID}
              role="dialog"
              aria-modal="true"
              aria-labelledby="viewer-study-panel-title"
              tabIndex={-1}
              className="relative flex h-full w-[min(24rem,92vw)] flex-col overscroll-contain border-l border-slate-800 bg-slate-900"
              onKeyDown={handleDialogKeyDown}
            >
              <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-3 py-2">
                <h2
                  id="viewer-study-panel-title"
                  className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400"
                >
                  {t('viewerPage.studyPanel')}
                </h2>
                <Button
                  variant="overlay"
                  size="sm"
                  onClick={() => setCompactDrawerOpen(false)}
                >
                  <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewerPage.closeStudyPanel')}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto bg-slate-800 p-px">
                <ViewerSidebar
                  volume={app.volume}
                  sourceLabel={app.sourceLabel}
                  dimensions={app.dimensions}
                  spacing={app.spacing}
                  windowBounds={app.windowBounds}
                  levelBounds={app.levelBounds}
                  mprZoom={app.mprZoom}
                  windowLevelDraft={app.windowLevelDraft}
                  progress={app.progress}
                  issue={app.issue}
                  cursor={app.cursor}
                  downsampled3D={app.downsampled3D}
                  selectedSeriesId={app.selectedSeriesId}
                  seriesChoices={app.seriesChoices}
                  onWindowChange={app.handleWindowChange}
                  onWindowCommit={app.handleWindowCommit}
                  onLevelChange={app.handleLevelChange}
                  onLevelCommit={app.handleLevelCommit}
                  onResetMprZoom={() => app.setMprZoom(1)}
                  onSeriesChange={(seriesId) => void app.selectSeries(seriesId)}
                  onOpenDirectory={() => void app.openDirectory()}
                  onBackToImport={app.resetViewer}
                />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
