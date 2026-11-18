import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  describe('preview thumbnails loading states', () => {
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

    const getTrack = (): HTMLElement => screen.getByTestId('main-track');

    it('does not fetch when given already parsed thumbnails', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: [
            { fromMs: 0, toMs: 100000, url: 'sprite.jpg' },
          ],
        })
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('calls onPreviewThumbnailsError once with the reason on non-2xx', async () => {
      const onError = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('nope', { status: 404 })
      );

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          onPreviewThumbnailsError: onError,
        })
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

      expect(onError.mock.calls[0][0].message).toBe('HTTP 404');
      expect(warn).toHaveBeenCalledOnce();
    });

    it('calls onPreviewThumbnailsError when parsing fails', async () => {
      const onError = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.reject(new Error('corrupt vtt')),
      } as Response);

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          onPreviewThumbnailsError: onError,
        })
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

      expect(onError.mock.calls[0][0].message).toBe('corrupt vtt');
    });

    it('does not call onPreviewThumbnailsError on success', async () => {
      const onError = vi.fn();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet.jpg#xywh=0,0,160,90\n'
        )
      );

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          onPreviewThumbnailsError: onError,
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 30 });
      await screen.findByTestId('preview-screen');

      expect(onError).not.toHaveBeenCalled();
    });

    it('falls back to getPreviewScreenUrl while the VTT is loading', () => {
      vi.spyOn(globalThis, 'fetch').mockReturnValue(
        new Promise(() => undefined)
      );

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          getPreviewScreenUrl: () => 'loading-fallback.jpg',
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("loading-fallback.jpg")'
      );
    });

    it('falls back to getPreviewScreenUrl after a loading failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('nope', { status: 500 })
      );

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      expect(
        (await screen.findByTestId('preview-screen')).style.backgroundImage
      ).toBe('url("fallback.jpg")');
    });

    it('shows no image on failure without fallback but keeps time and label', async () => {
      const onError = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('nope', { status: 404 })
      );

      render(
        getWrapper({
          max: 100000,
          previewThumbnails: '/media/thumbs.vtt',
          onPreviewThumbnailsError: onError,
          timeCodes: [{ fromMs: 0, description: 'Intro' }],
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 30 });
      await waitFor(() => expect(onError).toHaveBeenCalled());

      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      const hoverTime = screen.getByTestId('hover-time');
      expect(hoverTime).toHaveTextContent('Intro');
      expect(hoverTime).toHaveTextContent('00:00:30');
    });

    it('shows no image in a gap between cues without fallback', () => {
      render(
        getWrapper({
          max: 100000,
          previewThumbnails: [
            { fromMs: 0, toMs: 40000, url: 'sprite.jpg' },
            { fromMs: 60000, toMs: 100000, url: 'sprite.jpg' },
          ],
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 50 });

      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
      expect(screen.getByTestId('hover-time')).toHaveTextContent('00:00:50');
    });

    it('falls back to getPreviewScreenUrl in a gap between cues', () => {
      render(
        getWrapper({
          max: 100000,
          previewThumbnails: [
            { fromMs: 0, toMs: 40000, url: 'sprite.jpg' },
            { fromMs: 60000, toMs: 100000, url: 'sprite.jpg' },
          ],
          getPreviewScreenUrl: () => 'gap-fallback.jpg',
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 50 });

      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("gap-fallback.jpg")'
      );
    });

    it('ignores a late response from a previous VTT url', async () => {
      const pending = new Map<string, (response: Response) => void>();
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input) =>
          new Promise<Response>((resolve) =>
            pending.set(String(input), resolve)
          )
      );

      const { rerender } = render(
        getWrapper({ max: 100000, previewThumbnails: '/a.vtt' })
      );
      rerender(getWrapper({ max: 100000, previewThumbnails: '/b.vtt' }));

      await act(async () => {
        pending
          .get('http://localhost:3000/a.vtt')?.(
            new Response(
              'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\na.jpg#xywh=0,0,160,90\n'
            )
          );
        pending
          .get('http://localhost:3000/b.vtt')?.(
            new Response(
              'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nb.jpg#xywh=0,0,160,90\n'
            )
          );
      });

      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      const preview = await screen.findByTestId('preview-screen');
      const sprite = preview.firstElementChild as HTMLElement;

      expect(sprite.style.backgroundImage).toContain('b.jpg');
      expect(sprite.style.backgroundImage).not.toContain('a.jpg');
    });
  });
});
