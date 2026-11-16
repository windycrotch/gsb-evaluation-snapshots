import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import { CleanupRegistry } from '../../utils';
import {
  clampTooltipLeftPct,
  findChapterAtTime,
  getChapterForHover,
  isValidDuration,
} from './chapterUtils';
import type { ChapterMarker } from './chapterUtils';

// Re-export so existing imports from './chapterMarkerProgressBar' keep working.
export type { ChapterMarker } from './chapterUtils';
export { parseChaptersFromVTT } from './chapterUtils';

const Component = videojs.getComponent('Component');

interface ChapterMarkersProgressBarControlOptions {
  chapters: ChapterMarker[];
  children?: any[];
  className?: string;
}

/**
  * The class for chapter markers
  */
class ChapterMarkersProgressBarControl extends Component {
  private chapterTooltipContainer: HTMLElement | null = null;
  private chapterBoundaries: HTMLElement[] = [];
  private chapters: ChapterMarker[] = [];
  private cleanup_ = new CleanupRegistry();

  constructor(player: Player, options: ChapterMarkersProgressBarControlOptions) {
    super(player, options);
    this.chapters = options.chapters || [];

    player.ready(() => {
      if ((this as any).isDisposed && (this as any).isDisposed()) return;
      this.addMarkers(this.chapters, player);
      this.attachHoverHandlers(player);
      this.addChapterToSeekBarValueText_(player);
    });
  }

  /**
   * Removes the boundary markers and the tooltip container from the DOM.
   * Does NOT touch event listeners or the component itself — use dispose()
   * for full teardown.
   */
  private clearMarkers_() {
    this.chapterBoundaries.forEach((boundary) => {
      if (boundary && boundary.parentNode) {
        boundary.remove();
      }
    });
    this.chapterBoundaries = [];

    if (this.chapterTooltipContainer) {
      this.chapterTooltipContainer.remove();
      this.chapterTooltipContainer = null;
    }
  }

  /**
   * Creates the visual elements for chapter markers and a single tooltip container.
   */
  addMarkers(chapters: ChapterMarker[], player: Player) {
    const duration = player.duration();
    if (!isValidDuration(duration)) return;

    const playheadWell = player.el().querySelector('.vjs-progress-holder');
    if (!playheadWell) return;

    // Clear any previous markers (DOM only — listeners stay attached)
    this.clearMarkers_();

    // Create a single container for the chapter tooltip
    this.chapterTooltipContainer = document.createElement('div');
    this.chapterTooltipContainer.className = 'vjs-chapter-tooltip-container'; // New class for styling
    playheadWell.appendChild(this.chapterTooltipContainer);

    chapters.forEach((chapter, idx) => {
      if (chapter.startTime < 0 || chapter.endTime > duration || chapter.endTime <= chapter.startTime) {
        return;
      }

      const leftPct = (chapter.startTime / duration) * 100;

      // Only add boundary markers
      if (idx > 0) {
        const boundary = document.createElement('div');
        boundary.className = 'vjs-chapter-boundary';
        boundary.style.left = leftPct + '%';
        playheadWell.appendChild(boundary);
        this.chapterBoundaries.push(boundary);
      }
    });
  }

  /**
   * Attaches mouse move and leave handlers to the main progress control.
   */
  attachHoverHandlers(player: Player) {
    // Access controlBar.progressControl via type assertion (Video.js internal API)
    const playerWithControlBar = player as unknown as {
      controlBar: {
        progressControl: {
          el(): HTMLElement;
        };
      };
    };
    const progressControl = playerWithControlBar.controlBar && playerWithControlBar.controlBar.progressControl;
    if (!progressControl) return;

    const hideTooltip = () => {
      if (this.chapterTooltipContainer) {
        this.chapterTooltipContainer.style.display = 'none';
        // Clear the text so no stale chapter name lingers in the DOM
        this.chapterTooltipContainer.innerText = '';
      }
    };

    const mousemoveHandler = (e: MouseEvent) => {
      if (!this.chapterTooltipContainer) return;

      const duration = player.duration();
      const barRect = progressControl.el().getBoundingClientRect();

      if (!isValidDuration(duration) || barRect.width <= 0) {
        hideTooltip();
        return;
      }

      const progressHolder = progressControl.el().querySelector('.vjs-progress-holder') as HTMLElement | null;
      if (!progressHolder) {
        hideTooltip();
        return;
      }

      const pct = Math.max(0, Math.min(1, (e.clientX - barRect.left) / barRect.width));

      // Only show the tooltip when the hovered time is inside a valid chapter
      const chapter = getChapterForHover(this.chapters, duration, pct);

      if (!chapter) {
        hideTooltip();
        return;
      }

      const playerEl = player.el() as HTMLElement;
      const playerRect = playerEl.getBoundingClientRect();
      const progressHolderRect = progressHolder.getBoundingClientRect();

      // Update tooltip text first
      this.chapterTooltipContainer.innerText = chapter.label;
      this.chapterTooltipContainer.style.display = 'block';

      // Clamp using the tooltip's actual rendered width so it never
      // overflows the player's left/right edges
      const leftPct = clampTooltipLeftPct({
        pct,
        barWidth: barRect.width,
        barLeftInPlayer: barRect.left - playerRect.left,
        playerWidth: playerEl.offsetWidth,
        holderLeftInPlayer: progressHolderRect.left - playerRect.left,
        holderWidth: progressHolderRect.width,
        tooltipWidth: this.chapterTooltipContainer.offsetWidth,
      });

      this.chapterTooltipContainer.style.left = `${leftPct}%`;
    };

    this.cleanup_.registerVideoJsListener(progressControl, 'mousemove', mousemoveHandler);
    this.cleanup_.registerVideoJsListener(progressControl, 'mouseleave', hideTooltip);
  }

  /**
   * Appends the current chapter to the seek bar's aria-valuetext ("0:05 of 1:00,
   * Chapter: Intro"), so keyboard and screen-reader users get the chapter name that
   * mouse users see in the hover tooltip (WCAG 1.3.1, 2.1.1). Video.js rewrites the
   * attribute as time moves, so we re-append whenever it changes.
   */
  private addChapterToSeekBarValueText_(player: Player) {
    const seekBarEl = (player as any).getChild('ControlBar')?.getChild('ProgressControl')?.getChild('SeekBar')?.el() as HTMLElement | undefined;
    if (!seekBarEl || typeof MutationObserver === 'undefined') return;

    let suffix = '';
    const apply = () => {
      const current = seekBarEl.getAttribute('aria-valuetext') || '';
      const base = suffix && current.endsWith(suffix) ? current.slice(0, -suffix.length) : current;
      const time = player.currentTime() ?? 0;
      const chapter = findChapterAtTime(this.chapters, time);
      suffix = chapter ? `, ${player.localize('Chapter: {1}', [chapter.label])}` : '';
      const next = base + suffix;
      if (next !== current) seekBarEl.setAttribute('aria-valuetext', next);
    };

    const observer = new MutationObserver(apply);
    observer.observe(seekBarEl, { attributes: true, attributeFilter: ['aria-valuetext'] });
    this.cleanup_.register(() => {
      observer.disconnect();
      const current = seekBarEl.getAttribute('aria-valuetext') || '';
      if (suffix && current.endsWith(suffix)) seekBarEl.setAttribute('aria-valuetext', current.slice(0, -suffix.length));
    });
    apply();
  }

  /**
   * On dispose, remove all created elements and listeners.
   */
  dispose() {
    this.clearMarkers_();
    this.cleanup_.dispose();
    super.dispose();
  }
}

videojs.registerComponent('ChapterMarkersProgressBarControl', ChapterMarkersProgressBarControl);

export default ChapterMarkersProgressBarControl;
