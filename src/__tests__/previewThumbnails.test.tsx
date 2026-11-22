import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoSeekSlider, Props } from '..';

const getWrapper = (overrides: Partial<Props> = {}): any => (
  <VideoSeekSlider
    max={100000}
    currentTime={0}
    onChange={() => undefined}
    {...overrides}
  />
);

const vtt = (image: string): string =>
  `WEBVTT\n\n00:00:00.000 --> 00:01:40.000\n${image}#xywh=0,0,160,90\n`;

interface PendingRequest {
  url: string;
  signal: AbortSignal;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

describe('preview thumbnails over the network', () => {
  let requests: PendingRequest[];
  let fetchMock: ReturnType<typeof vi.spyOn>;

  /** Fetch mock that settles only when the test says so. `respectAbort: false` emulates a fetch that ignores the signal. */
  const mockFetch = (respectAbort = true): void => {
    fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const signal = init?.signal as AbortSignal;

        return new Promise<Response>((resolve, reject) => {
          requests.push({ url: String(input), signal, resolve, reject });

          if (respectAbort) {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError'))
            );
          }
        });
      });
  };

  const getTrack = (): HTMLElement => screen.getByTestId('main-track');
  const hover = (clientX = 30): void => {
    fireEvent.pointerMove(getTrack(), { clientX });
  };
  const leave = (): void => {
    fireEvent.pointerLeave(getTrack());
  };

  beforeEach(() => {
    requests = [];
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state on hover while the VTT is pending', async () => {
    mockFetch();
    render(getWrapper({ previewThumbnails: '/media/thumbs.vtt' }));

    hover();

    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();

    await act(async () => {
      requests[0].resolve(new Response(vtt('sheet.jpg')));
    });

    expect(screen.queryByTestId('preview-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-screen')).toBeInTheDocument();
  });

  it('aborts the old request on url change and never applies its late response', async () => {
    mockFetch();
    const { rerender } = render(
      getWrapper({ previewThumbnails: '/media/a.vtt' })
    );

    rerender(getWrapper({ previewThumbnails: '/media/b.vtt' }));

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('http://localhost:3000/media/a.vtt');
    expect(requests[1].url).toBe('http://localhost:3000/media/b.vtt');
    expect(requests[0].signal.aborted).toBe(true);

    hover();

    // The new url answers first…
    await act(async () => {
      requests[1].resolve(new Response(vtt('sheet-b.jpg')));
    });

    const sprite = () =>
      screen.getByTestId('preview-screen').firstElementChild as HTMLElement;
    expect(sprite().style.backgroundImage).toContain('sheet-b.jpg');

    // …and the stale one resolves afterwards (its promise already rejected via
    // abort, so resolve() is a no-op — the abort path is what must be safe).
    await act(async () => {
      requests[0].resolve(new Response(vtt('sheet-a.jpg')));
    });

    expect(sprite().style.backgroundImage).toContain('sheet-b.jpg');
  });

  it('ignores stale responses even when fetch does not respect the abort signal', async () => {
    mockFetch(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = render(
      getWrapper({ previewThumbnails: '/media/a.vtt' })
    );

    rerender(getWrapper({ previewThumbnails: '/media/b.vtt' }));
    hover();

    // Out of order: the stale url answers first, the current one second.
    await act(async () => {
      requests[0].resolve(new Response(vtt('sheet-a.jpg')));
    });

    expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();

    await act(async () => {
      requests[1].resolve(new Response(vtt('sheet-b.jpg')));
    });

    const sprite = screen.getByTestId('preview-screen')
      .firstElementChild as HTMLElement;
    expect(sprite.style.backgroundImage).toContain('sheet-b.jpg');

    // A late failure of the stale url must not surface either.
    await act(async () => {
      requests[0].reject(new Error('HTTP 500'));
    });

    expect(screen.queryByTestId('preview-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-screen')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows an error on hover after a failure and retries on the next hover', async () => {
    mockFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(getWrapper({ previewThumbnails: '/media/thumbs.vtt' }));

    hover();
    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();

    await act(async () => {
      requests[0].resolve(new Response('nope', { status: 500 }));
    });

    expect(screen.getByTestId('preview-error')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-screen')).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalledOnce();

    // Still hovering: no automatic retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The next hover retries the same url.
    leave();
    hover(40);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[1].url).toBe(requests[0].url);
    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();

    await act(async () => {
      requests[1].resolve(new Response(vtt('sheet.jpg')));
    });

    expect(screen.queryByTestId('preview-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-screen')).toBeInTheDocument();
  });

  it('aborts the pending request on unmount without state update warnings', async () => {
    mockFetch();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { unmount } = render(
      getWrapper({ previewThumbnails: '/media/thumbs.vtt' })
    );

    unmount();

    expect(requests[0].signal.aborted).toBe(true);

    await act(async () => undefined);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not fetch when given already parsed thumbnails', () => {
    mockFetch();
    render(
      getWrapper({
        previewThumbnails: [
          {
            fromMs: 0,
            toMs: 100000,
            url: 'sprite.jpg',
            x: 0,
            y: 0,
            width: 320,
            height: 180,
          },
        ],
      })
    );

    hover();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-error')).not.toBeInTheDocument();
  });
});
