import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoSeekSlider, Props, PreviewThumbnail } from '..';

const TRACK_WIDTH = 100;

const getWrapper = (overrides: Partial<Props> = {}): any => (
  <VideoSeekSlider
    max={100000}
    currentTime={0}
    onChange={() => undefined}
    {...overrides}
  />
);

const getTrack = (): HTMLElement => screen.getByTestId('main-track');

const getSprite = (): HTMLElement =>
  screen.getByTestId('preview-screen').firstElementChild as HTMLElement;

interface Deferred {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const deferred = (): Deferred => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const VTT_A = `WEBVTT

00:00:00.000 --> 00:00:50.000
sheet-a.jpg#xywh=160,0,160,90

00:00:50.000 --> 00:01:40.000
sheet-a.jpg#xywh=320,0,160,90
`;

const VTT_B = `WEBVTT

00:00:00.000 --> 00:01:40.000
sheet-b.jpg#xywh=160,0,160,90
`;

describe('preview thumbnails loading chain', () => {
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
    vi.unstubAllGlobals();
  });

  describe('successful load', () => {
    it('shows the sprite slice of the hovered interval and follows the hover time', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(VTT_A));

      render(getWrapper({ previewThumbnails: '/thumbs.vtt' }));
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      await screen.findByTestId('preview-screen');
      expect(getSprite().style.backgroundPosition).toBe('-160px 0px');
      expect(getSprite().style.backgroundImage).toContain(
        'http://localhost:3000/sheet-a.jpg'
      );

      // The preview keeps tracking the hover time while scrubbing.
      fireEvent.pointerMove(getTrack(), { clientX: 70 });
      expect(getSprite().style.backgroundPosition).toBe('-320px 0px');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('failed load', () => {
    it('shows no stale preview and retries the same url on the next entry', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        /* keep the test output clean */
      });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue(new Response(VTT_A));

      const { rerender } = render(
        getWrapper({ previewThumbnails: '/thumbs.vtt' })
      );
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      // The same address must be fetched again the next time it is passed in.
      rerender(getWrapper({ previewThumbnails: undefined }));
      rerender(getWrapper({ previewThumbnails: '/thumbs.vtt' }));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenLastCalledWith(
        'http://localhost:3000/thumbs.vtt',
        expect.anything()
      );

      await screen.findByTestId('preview-screen');
      expect(getSprite().style.backgroundImage).toContain('sheet-a.jpg');
    });

    it('does not keep previously loaded thumbnails when the next source fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {
        /* keep the test output clean */
      });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(VTT_A))
        .mockRejectedValueOnce(new Error('HTTP 404'));

      const { rerender } = render(getWrapper({ previewThumbnails: '/a.vtt' }));
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      await screen.findByTestId('preview-screen');

      rerender(getWrapper({ previewThumbnails: '/missing.vtt' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
    });
  });

  describe('source change race', () => {
    it('aborts the previous request, clears its thumbnails and ignores late results', async () => {
      const first = deferred();
      const second = deferred();
      const third = deferred();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockImplementationOnce(() => third.promise);

      const { rerender } = render(getWrapper({ previewThumbnails: '/a.vtt' }));
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      // Change the source before A responds: the old request is aborted and
      // the previous thumbnails are cleared immediately.
      rerender(getWrapper({ previewThumbnails: '/b.vtt' }));

      const firstSignal = fetchMock.mock.calls[0][1]
        ?.signal as AbortSignal;
      expect(firstSignal.aborted).toBe(true);
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      // A's late response must not be written over the new source.
      await act(async () => first.resolve(new Response(VTT_A)));
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      // B's response is the one that gets shown.
      await act(async () => second.resolve(new Response(VTT_B)));
      expect(getSprite().style.backgroundImage).toContain('sheet-b.jpg');

      // Back to A: fetched again, and nothing stale is shown while loading.
      rerender(getWrapper({ previewThumbnails: '/a.vtt' }));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      await act(async () => third.resolve(new Response(VTT_A)));
      expect(getSprite().style.backgroundImage).toContain('sheet-a.jpg');
    });
  });

  describe('interval gaps', () => {
    const gapped: PreviewThumbnail[] = [
      {
        fromMs: 0,
        toMs: 50000,
        url: 'sheet.jpg',
        x: 0,
        y: 0,
        width: 160,
        height: 90,
      },
      {
        fromMs: 60000,
        toMs: 100000,
        url: 'sheet.jpg',
        x: 160,
        y: 0,
        width: 160,
        height: 90,
      },
    ];

    it('falls back to getPreviewScreenUrl when the hover time is in a gap', () => {
      render(
        getWrapper({
          previewThumbnails: gapped,
          getPreviewScreenUrl: () => 'fallback.jpg',
        })
      );

      fireEvent.pointerMove(getTrack(), { clientX: 55 });

      expect(screen.getByTestId('preview-screen').style.backgroundImage).toBe(
        'url("fallback.jpg")'
      );
    });

    it('shows no preview in a gap without getPreviewScreenUrl', () => {
      render(getWrapper({ previewThumbnails: gapped }));

      fireEvent.pointerMove(getTrack(), { clientX: 55 });

      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
    });

    it('shows the sprite slice again once the hover time re-enters an interval', () => {
      render(getWrapper({ previewThumbnails: gapped }));

      fireEvent.pointerMove(getTrack(), { clientX: 55 });
      expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

      fireEvent.pointerMove(getTrack(), { clientX: 70 });
      expect(getSprite().style.backgroundPosition).toBe('-160px 0px');
    });
  });

  describe('sprite preloading', () => {
    const twoSheets: PreviewThumbnail[] = [
      {
        fromMs: 0,
        toMs: 50000,
        url: 'sheet-1.jpg',
        x: 0,
        y: 0,
        width: 160,
        height: 90,
      },
      {
        fromMs: 50000,
        toMs: 100000,
        url: 'sheet-2.jpg',
        x: 160,
        y: 0,
        width: 160,
        height: 90,
      },
    ];

    const stubImage = (): {
      created: string[];
      decodeResolvers: Array<() => void>;
    } => {
      const created: string[] = [];
      const decodeResolvers: Array<() => void> = [];

      class MockImage {
        private currentSrc = '';
        decode = vi.fn(
          () => new Promise<void>((resolve) => decodeResolvers.push(resolve))
        );

        set src(value: string) {
          this.currentSrc = value;
          created.push(value);
        }

        get src(): string {
          return this.currentSrc;
        }
      }

      vi.stubGlobal('Image', MockImage);

      return { created, decodeResolvers };
    };

    it('preloads the next sheet only after the previous one has decoded', async () => {
      const { created, decodeResolvers } = stubImage();

      render(getWrapper({ previewThumbnails: twoSheets }));
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      // Decoding happens in the background, one sheet at a time.
      expect(created).toEqual(['sheet-1.jpg']);
      expect(decodeResolvers).toHaveLength(1);

      await act(async () => decodeResolvers[0]());
      expect(created).toEqual(['sheet-1.jpg', 'sheet-2.jpg']);
    });

    it('does not start new preloads after unmount', async () => {
      const { created, decodeResolvers } = stubImage();

      const { unmount } = render(getWrapper({ previewThumbnails: twoSheets }));
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      expect(created).toEqual(['sheet-1.jpg']);

      unmount();

      // The in-flight decode finishes after unmount: the chain must stop.
      await act(async () => decodeResolvers[0]());
      expect(created).toEqual(['sheet-1.jpg']);
    });

    it('does not start new preloads after the thumbnails change', async () => {
      const { created, decodeResolvers } = stubImage();

      const { rerender } = render(
        getWrapper({ previewThumbnails: twoSheets })
      );
      fireEvent.pointerMove(getTrack(), { clientX: 30 });

      expect(created).toEqual(['sheet-1.jpg']);

      rerender(
        getWrapper({
          previewThumbnails: [
            { ...twoSheets[0], url: 'sheet-3.jpg' },
            { ...twoSheets[1], url: 'sheet-4.jpg' },
          ],
        })
      );

      // The old chain is cancelled; only the new sheets are preloaded.
      await act(async () => decodeResolvers[0]());
      expect(created).toEqual(['sheet-1.jpg', 'sheet-3.jpg']);
    });
  });
});
