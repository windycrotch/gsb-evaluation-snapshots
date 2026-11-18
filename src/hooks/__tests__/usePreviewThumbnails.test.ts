import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePreviewThumbnails } from '../usePreviewThumbnails';
import { PreviewThumbnail } from '../../utils/parseThumbnailsVtt';

const VTT =
  'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nsheet.jpg#xywh=0,0,160,90\n';

const thumbnails: PreviewThumbnail[] = [
  { fromMs: 0, toMs: 10000, url: 'sprite.jpg', x: 0, y: 0, width: 160, height: 90 },
];

describe('usePreviewThumbnails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a thumbnails array synchronously as loaded without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { result } = renderHook(() => usePreviewThumbnails(thumbnails));

    expect(result.current).toEqual({ thumbnails, status: 'loaded' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an undefined source as loaded without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { result } = renderHook(() => usePreviewThumbnails(undefined));

    expect(result.current).toEqual({ thumbnails: undefined, status: 'loaded' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads thumbnails from a VTT url: loading, then loaded', async () => {
    const onError = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VTT));

    const { result } = renderHook(() =>
      usePreviewThumbnails('/thumbs.vtt', onError)
    );

    expect(result.current).toEqual({ status: 'loading' });

    await waitFor(() => expect(result.current.status).toBe('loaded'));

    expect(result.current.thumbnails).toHaveLength(1);
    expect(result.current.thumbnails?.[0].url).toBe(
      'http://localhost:3000/sheet.jpg'
    );
    expect(result.current.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a non-2xx response as an error with the reason', async () => {
    const onError = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 404 })
    );

    const { result } = renderHook(() =>
      usePreviewThumbnails('/thumbs.vtt', onError)
    );

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.thumbnails).toBeUndefined();
    expect(result.current.error?.message).toBe('HTTP 404');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('HTTP 404');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a parsing failure as an error with the reason', async () => {
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.reject(new Error('corrupt vtt')),
    } as Response);

    const { result } = renderHook(() =>
      usePreviewThumbnails('/thumbs.vtt', onError)
    );

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.error?.message).toBe('corrupt vtt');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('corrupt vtt');
  });

  it('discards a late response from a previous url', async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input) =>
        new Promise<Response>((resolve) => pending.set(String(input), resolve))
    );

    const { result, rerender } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      { initialProps: { source: '/a.vtt' } }
    );

    rerender({ source: '/b.vtt' });
    expect(result.current.status).toBe('loading');

    // The old url resolves after the new one was already requested.
    await act(async () => {
      pending.get('http://localhost:3000/a.vtt')?.(new Response(VTT));
    });

    expect(result.current.status).toBe('loading');

    await act(async () => {
      pending
        .get('http://localhost:3000/b.vtt')?.(
          new Response(
            'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nb.jpg#xywh=0,0,160,90\n'
          )
        );
    });

    expect(result.current.status).toBe('loaded');
    expect(result.current.thumbnails?.[0].url).toBe(
      'http://localhost:3000/b.jpg'
    );
  });

  it('discards a late failure from a previous url', async () => {
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = new Map<string, (response: Response) => void>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input) =>
        new Promise<Response>((resolve) => pending.set(String(input), resolve))
    );

    const { result, rerender } = renderHook(
      ({ source }) => usePreviewThumbnails(source, onError),
      { initialProps: { source: '/a.vtt' } }
    );

    rerender({ source: '/b.vtt' });

    await act(async () => {
      pending
        .get('http://localhost:3000/a.vtt')?.(
          new Response('gone', { status: 500 })
        );
    });

    // The failure belongs to the old url: the new one is still loading.
    expect(result.current.status).toBe('loading');
  });
});
