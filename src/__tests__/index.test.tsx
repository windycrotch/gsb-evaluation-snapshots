import {
  act,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { VideoSeekSlider, Props } from '..';

const getWrapper = (overrides: Partial<Props> = {}): any => (
  <VideoSeekSlider
    max={1000}
    currentTime={500}
    bufferTime={600}
    onChange={() => undefined}
    offset={0}
    limitTimeTooltipBySides={true}
    secondsPrefix="00:00:"
    minutesPrefix="00:"
    {...overrides}
  />
);

describe('VideoSeekSlider.tsx', () => {
  it('should render without errors', () => {
    render(getWrapper());
  });

  it('should render without hover time ', () => {
    render(getWrapper({ hideThumbTooltip: true }));
    expect(screen.queryByTestId('hover-time')).not.toBeInTheDocument();
  });

  it('should show hover-time by default', () => {
    render(getWrapper());
    expect(screen.getByTestId('hover-time')).toBeInTheDocument();
  });

  describe('interaction', () => {
    const TRACK_WIDTH = 100;

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
        TRACK_WIDTH
      );
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: TRACK_WIDTH,
      } as DOMRect);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const getTrack = (): HTMLElement => screen.getByTestId('main-track');

    it('seeks on pointer down and reports offset time in ms', () => {
      const onChange = vi.fn();
      render(getWrapper({ max: 100000, offset: 5000, onChange }));

      fireEvent.pointerDown(getTrack(), { clientX: 25, button: 0 });

      expect(onChange).toHaveBeenCalledWith(25000, 30000);
    });

    it('keeps seeking while dragging and clamps outside the track', () => {
      const onChange = vi.fn();
      render(getWrapper({ max: 100000, onChange }));

      fireEvent.pointerDown(getTrack(), { clientX: 10, button: 0 });
      fireEvent.pointerMove(getTrack(), { clientX: 500 });
      fireEvent.pointerMove(getTrack(), { clientX: -50 });

      expect(onChange.mock.calls.map(([time]) => time)).toEqual([
        10000, 100000, 0,
      ]);

      fireEvent.pointerUp(getTrack(), { clientX: -50 });
      fireEvent.pointerMove(getTrack(), { clientX: 70 });

      expect(onChange).toHaveBeenCalledTimes(3);
    });

    it('ignores non-primary buttons', () => {
      const onChange = vi.fn();
      render(getWrapper({ onChange }));

      fireEvent.pointerDown(getTrack(), { clientX: 10, button: 2 });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('calls the latest onChange after rerender', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = render(getWrapper({ onChange: first }));

      rerender(getWrapper({ onChange: second }));
      fireEvent.pointerDown(getTrack(), { clientX: 50, button: 0 });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    });

    it('does not attach listeners to window', () => {
      const addListener = vi.spyOn(window, 'addEventListener');
      render(getWrapper());

      const types = addListener.mock.calls.map(([type]) => type);

      expect(types).not.toContain('mousemove');
      expect(types).not.toContain('touchmove');
      expect(types).not.toContain('mouseup');
    });

    it('shows hover time with offset in ms', () => {
      render(getWrapper({ max: 100000, offset: 10000 }));

      fireEvent.pointerMove(getTrack(), { clientX: 50 });

      expect(screen.getByTestId('hover-time')).toHaveTextContent('01:00');
    });

    it('shows the label of the hovered time code', () => {
      render(
        getWrapper({
          max: 100000,
          timeCodes: [
            { fromMs: 0, description: 'Intro' },
            { fromMs: 40000, description: 'Main part' },
          ],
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 60 });
      expect(screen.getByTestId('hover-time')).toHaveTextContent('Main part');

      fireEvent.pointerMove(getTrack(), { clientX: 20 });
      expect(screen.getByTestId('hover-time')).toHaveTextContent('Intro');
    });

    it('renders the track when timeCodes is an empty array', () => {
      const { container } = render(getWrapper({ timeCodes: [] }));

      expect(container.querySelectorAll('.track .main')).toHaveLength(1);
    });
  });

  describe('previews and heatmap', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
        100
      );
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: 100,
      } as DOMRect);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const thumbnails = [
      {
        fromMs: 0,
        toMs: 50000,
        url: 'sprite.jpg',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
      },
      {
        fromMs: 50000,
        toMs: 100000,
        url: 'sprite.jpg',
        x: 320,
        y: 0,
        width: 320,
        height: 180,
      },
    ];

    it('shows the sprite fragment for the hovered time', () => {
      render(getWrapper({ max: 100000, previewThumbnails: thumbnails }));

      fireEvent.pointerMove(screen.getByTestId('main-track'), { clientX: 70 });

      const preview = screen.getByTestId('preview-screen');
      const sprite = preview.firstElementChild as HTMLElement;

      expect(preview).toHaveStyle({ height: '90px' });
      expect(sprite.style.backgroundPosition).toBe('-320px 0px');
      expect(sprite.style.transform).toBe('scale(0.5)');
    });

    it('loads thumbnails from a VTT url', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet.jpg#xywh=0,0,160,90\n'
          )
        );

      render(
        getWrapper({ max: 100000, previewThumbnails: '/media/thumbs.vtt' })
      );
      fireEvent.pointerMove(screen.getByTestId('main-track'), { clientX: 30 });

      const preview = await screen.findByTestId('preview-screen');
      const sprite = preview.firstElementChild as HTMLElement;

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/media/thumbs.vtt',
        expect.anything()
      );
      expect(sprite.style.backgroundImage).toContain(
        'http://localhost:3000/media/sheet.jpg'
      );
    });

    it('falls back to getPreviewScreenUrl outside the thumbnails', () => {
      render(
        getWrapper({
          max: 200000,
          previewThumbnails: thumbnails,
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );

      fireEvent.pointerMove(screen.getByTestId('main-track'), { clientX: 80 });

      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("fallback.jpg")'
      );
    });

    it('renders the heatmap only with data and activates it on hover', () => {
      const { rerender } = render(getWrapper({ heatmap: [] }));
      expect(screen.queryByTestId('heatmap')).not.toBeInTheDocument();

      rerender(getWrapper({ heatmap: [1, 3, 2] }));
      const heatmap = screen.getByTestId('heatmap');

      expect(heatmap).not.toHaveClass('active');

      fireEvent.pointerMove(screen.getByTestId('main-track'), { clientX: 40 });
      expect(heatmap).toHaveClass('active');
    });
  });

  describe('thumbnail sessions', () => {
    const VTT_A =
      'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet-a.jpg#xywh=0,0,160,90\n';
    const VTT_B =
      'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet-b.jpg#xywh=0,0,160,90\n';

    interface PendingFetch {
      promise: Promise<Response>;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      signal: AbortSignal;
    }

    const track = (): HTMLElement => screen.getByTestId('main-track');
    const hover = (): void =>
      fireEvent.pointerMove(track(), { clientX: 30 });

    const stubPendingFetch = (): PendingFetch[] => {
      const pending: PendingFetch[] = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        let resolve!: (response: Response) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<Response>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const entry: PendingFetch = {
          promise,
          resolve,
          reject,
          signal: init?.signal as AbortSignal,
        };
        pending.push(entry);
        return promise;
      });

      return pending;
    };

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
        100
      );
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: 100,
      } as DOMRect);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('never shows the previous source while the new VTT is loading and accepts only its own response', async () => {
      const pending = stubPendingFetch();
      const { rerender } = render(
        getWrapper({ max: 100000, previewThumbnails: '/media/a.vtt' })
      );
      hover();

      rerender(
        getWrapper({ max: 100000, previewThumbnails: '/media/b.vtt' })
      );

      expect(pending[0].signal.aborted).toBe(true);
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      // The late response of source A must not write anything into the session.
      pending[0].resolve(new Response(VTT_A));
      await pending[0].promise;
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      pending[1].resolve(new Response(VTT_B));
      const preview = await screen.findByTestId('preview-screen');

      expect(preview.textContent).toBe('');
      expect(
        (preview.firstElementChild as HTMLElement).style.backgroundImage
      ).toContain('sheet-b.jpg');
    });

    it('falls back to getPreviewScreenUrl while a VTT source is loading', () => {
      const pending = stubPendingFetch();
      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/a.vtt',
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );
      hover();

      expect(pending).toHaveLength(1);
      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("fallback.jpg")'
      );
    });

    it('keeps the failed state and falls back to getPreviewScreenUrl on hover', async () => {
      const pending = stubPendingFetch();
      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/broken.vtt',
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );

      await act(async () => {
        pending[0].reject(new Error('network down'));
        await pending[0].promise.catch(() => undefined);
      });

      hover();
      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("fallback.jpg")'
      );
      // eslint-disable-next-line no-console
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('shows only the time label on failure when no fallback source is provided', async () => {
      const pending = stubPendingFetch();
      render(
        getWrapper({ max: 100000, previewThumbnails: '/media/broken.vtt' })
      );

      await act(async () => {
        pending[0].reject(new Error('network down'));
        await pending[0].promise.catch(() => undefined);
      });

      expect(() => hover()).not.toThrow();
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
      expect(screen.getByTestId('hover-time')).toHaveTextContent('00:30');
    });

    it('recovers after clearing a failed source and works again with inline thumbnails', async () => {
      const pending = stubPendingFetch();
      const { rerender } = render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/broken.vtt',
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );

      await act(async () => {
        pending[0].reject(new Error('network down'));
        await pending[0].promise.catch(() => undefined);
      });

      rerender(
        getWrapper({
          max: 100000,
          previewThumbnails: undefined,
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );
      hover();
      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("fallback.jpg")'
      );

      const inline = [
        {
          fromMs: 0,
          toMs: 100000,
          url: 'inline.jpg',
          x: 0,
          y: 0,
          width: 320,
          height: 180,
        },
      ];
      rerender(getWrapper({ max: 100000, previewThumbnails: inline }));
      hover();

      expect(
        (
          screen.getByTestId('preview-screen')
            .firstElementChild as HTMLElement
        ).style.backgroundImage
      ).toContain('inline.jpg');
    });

    it('drops in-flight requests immediately when the string source is cleared', () => {
      const pending = stubPendingFetch();
      const { rerender } = render(
        getWrapper({ max: 100000, previewThumbnails: '/media/a.vtt' })
      );

      rerender(getWrapper({ max: 100000, previewThumbnails: undefined }));

      expect(pending[0].signal.aborted).toBe(true);
      hover();
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
    });

    it('preloads each sprite sheet once per effective set and stops warming the old set on switch', () => {
      const created: string[] = [];
      const blanked: string[] = [];
      class ImageMock {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        private srcValue = '';

        set src(value: string) {
          if (value.startsWith('data:')) {
            blanked.push(this.srcValue);
          } else if (value) {
            created.push(value);
          }
          this.srcValue = value;
        }

        get src(): string {
          return this.srcValue;
        }
      }
      vi.stubGlobal('Image', ImageMock);

      const firstSet = [
        { fromMs: 0, toMs: 50000, url: 'sprite-a.jpg', width: 10, height: 10 },
        {
          fromMs: 50000,
          toMs: 100000,
          url: 'sprite-a.jpg',
          width: 10,
          height: 10,
        },
      ];
      const { rerender } = render(
        getWrapper({ max: 100000, previewThumbnails: firstSet })
      );

      hover();
      expect(created).toEqual(['sprite-a.jpg']);

      // Repeated hovers over the same set must not create images again.
      fireEvent.pointerLeave(track());
      hover();
      fireEvent.pointerLeave(track());
      hover();
      expect(created).toEqual(['sprite-a.jpg']);

      const secondSet = [
        { fromMs: 0, toMs: 100000, url: 'sprite-b.jpg', width: 10, height: 10 },
      ];
      rerender(getWrapper({ max: 100000, previewThumbnails: secondSet }));
      hover();

      expect(blanked).toContain('sprite-a.jpg');
      expect(created).toEqual(['sprite-a.jpg', 'sprite-b.jpg']);

      vi.unstubAllGlobals();
    });
  });
});
