import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Ratio,
  RotateCcw,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../i18n';
import {
  createThreePreview,
  type ThreePreviewInstance,
} from '../lib/volume/three-preview';
import type { PreparedVolumeFor3D, VolumeCursor } from '../types';
import { Button } from './Button';

interface VolumeViewport3DProps {
  volume: PreparedVolumeFor3D | null;
  cursor?: VolumeCursor | null;
  axisViewsVisible?: boolean;
  onAxisViewsVisibleChange?: (visible: boolean) => void;
  sidebarVisible?: boolean;
  onSidebarVisibleChange?: (visible: boolean) => void;
  onDownsampledChange?: (downsampled: boolean) => void;
  axisViewsControlsId?: string;
  sidebarControlsId?: string;
}

export function VolumeViewport3D({
  volume,
  cursor = null,
  axisViewsVisible = true,
  onAxisViewsVisibleChange,
  sidebarVisible = true,
  onSidebarVisibleChange,
  onDownsampledChange,
  axisViewsControlsId,
  sidebarControlsId,
}: VolumeViewport3DProps) {
  const { t } = useTranslation();
  const instructionsId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ThreePreviewInstance | null>(null);
  const cursorRef = useRef<VolumeCursor | null>(cursor);
  const [error, setError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [planesVisible, setPlanesVisible] = useState(true);
  const planesVisibleRef = useRef(planesVisible);

  useEffect(() => {
    cursorRef.current = cursor;
    instanceRef.current?.focusCursor(cursor);
  }, [cursor]);

  useEffect(() => {
    planesVisibleRef.current = planesVisible;
    instanceRef.current?.setPlanesVisible(planesVisible);
  }, [planesVisible]);

  useEffect(() => {
    onDownsampledChange?.(Boolean(volume?.downsampled));
  }, [onDownsampledChange, volume?.downsampled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !volume) {
      setError(false);
      setPreviewReady(false);
      return undefined;
    }

    let cleanup: () => void = () => {};
    let cancelled = false;
    let mounted = false;
    let frame = 0;
    let retryTimer = 0;
    let retryCount = 0;
    let resizeObserver: ResizeObserver | null = null;
    setError(false);
    setPreviewReady(false);

    const scheduleRetry = () => {
      if (cancelled || mounted || retryCount >= 4) return;
      retryCount += 1;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        mount();
        if (!mounted) scheduleRetry();
      }, 120 * retryCount);
    };

    const mount = () => {
      if (cancelled || mounted) return;
      if (host.clientWidth < 32 || host.clientHeight < 32) return;
      mounted = true;
      resizeObserver?.disconnect();
      resizeObserver = null;

      void createThreePreview(host, volume)
        .then((instance) => {
          if (cancelled) {
            instance.dispose();
            return;
          }

          instanceRef.current = instance;
          instance.focusCursor(cursorRef.current);
          instance.setPlanesVisible(planesVisibleRef.current);
          cleanup = instance.dispose;
          setPreviewReady(true);
        })
        .catch((_renderError: unknown) => {
          if (cancelled) return;
          mounted = false;
          if (retryCount < 4) {
            scheduleRetry();
            return;
          }
          setError(true);
          setPreviewReady(false);
        });
    };

    frame = window.requestAnimationFrame(() => {
      mount();
      if (mounted || cancelled) return;

      resizeObserver = new ResizeObserver(() => {
        mount();
      });
      resizeObserver.observe(host);
      scheduleRetry();
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retryTimer);
      resizeObserver?.disconnect();
      instanceRef.current = null;
      cleanup();
    };
  }, [volume]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const instance = instanceRef.current;
    if (!instance) return;
    const rotationStep = (Math.PI / 30) * (event.shiftKey ? 2.5 : 1);

    switch (event.key) {
      case 'ArrowLeft':
        instance.rotateView(-rotationStep, 0);
        break;
      case 'ArrowRight':
        instance.rotateView(rotationStep, 0);
        break;
      case 'ArrowUp':
        instance.rotateView(0, -rotationStep);
        break;
      case 'ArrowDown':
        instance.rotateView(0, rotationStep);
        break;
      case '+':
      case '=':
        instance.zoomView(0.86);
        break;
      case '-':
      case '_':
        instance.zoomView(1 / 0.86);
        break;
      case '0':
        instance.resetView();
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-black">
      <div
        ref={hostRef}
        id="volume-3d-surface"
        className="focus-surface absolute inset-0 h-full min-h-0 overflow-hidden"
        role="application"
        tabIndex={volume ? 0 : -1}
        aria-label={t('volumeViewport3d.surfaceLabel')}
        aria-describedby={instructionsId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) =>
          event.currentTarget.focus({ preventScroll: true })
        }
      />
      <span id={instructionsId} className="sr-only">
        {t('volumeViewport3d.keyboardInstructions')}
      </span>
      <div className="absolute inset-0 z-20 pointer-events-none">
        <div className="pointer-events-auto absolute inset-x-2 bottom-2 grid grid-cols-2 items-center gap-1 sm:inset-x-auto sm:right-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={axisViewsVisible}
            aria-controls={axisViewsControlsId}
            onClick={() => onAxisViewsVisibleChange?.(!axisViewsVisible)}
          >
            {axisViewsVisible ? (
              <PanelBottomClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelBottomOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {axisViewsVisible
              ? t('volumeViewport3d.hideAxisViewsShort')
              : t('volumeViewport3d.showAxisViewsShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={sidebarVisible}
            aria-controls={sidebarControlsId}
            onClick={() => onSidebarVisibleChange?.(!sidebarVisible)}
          >
            {sidebarVisible ? (
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {sidebarVisible
              ? t('volumeViewport3d.hideSidebarShort')
              : t('volumeViewport3d.showSidebarShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-pressed={planesVisible}
            aria-controls="volume-3d-surface"
            onClick={() => setPlanesVisible((current) => !current)}
          >
            <Ratio className="h-3.5 w-3.5" aria-hidden="true" />
            {planesVisible
              ? t('volumeViewport3d.hidePlanesShort')
              : t('volumeViewport3d.showPlanesShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            disabled={!previewReady}
            onClick={() => instanceRef.current?.resetView()}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('volumeViewport3d.resetViewShort')}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/85 px-4 text-center text-xs text-slate-400">
          {t('volumeViewport3d.previewError')}
        </div>
      ) : null}
    </div>
  );
}
