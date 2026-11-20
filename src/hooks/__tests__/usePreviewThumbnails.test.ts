import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewThumbnails } from '../usePreviewThumbnails';
import { PreviewThumbnail } from '../../utils/parseThumbnailsVtt';

const VTT_A =
  'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet-a.jpg#xywh=0,0,160,90\n';
const VTT_B =
  'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet-b.jpg#xywh=0,0,160,90\n';

interface DeferredFetch {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
}

const deferredResponse = (): DeferredFetch => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  let signal!: AbortSignal;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    signal = init?.signal as AbortSignal;
    return promise;
  });

  return {
    promise,
    resolve,
    reject,
    get signal() {
      return signal;
    },
  };
};

const renderUse = (source: string | PreviewThumbnail[] | undefined) =>
  renderHook(({ source: current }) => usePreviewThumbnails(current), {
    initialProps: { source },
  });

describe('usePreviewThumbnails', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a parsed array as-is without fetching', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const thumbnails = [{ fromMs: 0, toMs: 1000, url: 'sprite.jpg' }];
    const { result } = renderUse(thumbnails);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      thumbnails,
      status: 'loaded',
      error: undefined,
    });
  });

  it('returns undefined for an empty source without fetching', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { result } = renderUse(undefined);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      thumbnails: undefined,
      status: 'loaded',
      error: undefined,
    });
  });

  it('loads and parses a VTT url, exposing the resolved base url', async () => {
    const deferred = deferredResponse();
    const { result } = renderUse('/media/a.vtt');

    expect(result.current).toMatchObject({ status: 'loading' });
    expect(result.current.thumbnails).toBeUndefined();

    await act(async () => {
      deferred.resolve(new Response(VTT_A));
      await deferred.promise;
    });

    expect(result.current.status).toBe('loaded');
    expect(result.current.thumbnails?.[0].url).toBe(
      'http://localhost:3000/media/sheet-a.jpg'
    );
    expect(result.current.error).toBeUndefined();
  });

  it('keeps an observable failure state instead of swallowing the error', async () => {
    const deferred = deferredResponse();
    const { result } = renderUse('/media/broken.vtt');

    await act(async () => {
      deferred.reject(new Error('network down'));
      await deferred.promise.catch(() => undefined);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('network down');
    expect(result.current.thumbnails).toBeUndefined();
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalled();
  });

  it('treats an HTTP error response as a failed session', async () => {
    const deferred = deferredResponse();
    const { result } = renderUse('/media/missing.vtt');

    await act(async () => {
      deferred.resolve(new Response('nope', { status: 404 }));
      await deferred.promise;
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('HTTP 404');
    expect(result.current.thumbnails).toBeUndefined();
  });

  it('turns an unparseable url into an error session instead of throwing', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { result } = renderUse('http://example.com:bad');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(TypeError);
    expect(result.current.thumbnails).toBeUndefined();
  });

  it('cancels the old request when switching string sources mid-flight', () => {
    const first = deferredResponse();
    const { rerender, result } = renderUse('/media/a.vtt');

    expect(first.signal.aborted).toBe(false);

    const second = deferredResponse();
    rerender({ source: '/media/b.vtt' });

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(result.current).toMatchObject({ status: 'loading' });
    expect(result.current.thumbnails).toBeUndefined();
  });

  it('drops a late successful response from a previous source', async () => {
    const first = deferredResponse();
    const { rerender, result } = renderUse('/media/a.vtt');

    const second = deferredResponse();
    rerender({ source: '/media/b.vtt' });

    await act(async () => {
      first.resolve(new Response(VTT_A));
      await first.promise;
    });

    // A arrived late: the current session is still B, still loading.
    expect(result.current.status).toBe('loading');
    expect(result.current.thumbnails).toBeUndefined();

    await act(async () => {
      second.resolve(new Response(VTT_B));
      await second.promise;
    });

    expect(result.current.status).toBe('loaded');
    expect(result.current.thumbnails?.[0].url).toContain('sheet-b.jpg');
  });

  it('drops a late failure from a previous source and keeps the new session clean', async () => {
    const first = deferredResponse();
    const { rerender, result } = renderUse('/media/a.vtt');

    const second = deferredResponse();
    rerender({ source: '/media/b.vtt' });

    await act(async () => {
      first.reject(new Error('late failure'));
      await first.promise.catch(() => undefined);
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      second.resolve(new Response(VTT_B));
      await second.promise;
    });

    expect(result.current).toMatchObject({
      status: 'loaded',
      error: undefined,
    });
    expect(result.current.thumbnails?.[0].url).toContain('sheet-b.jpg');
  });

  it('immediately discards an in-flight request and failure state when switching to an array', async () => {
    const first = deferredResponse();
    const { rerender, result } = renderUse('/media/a.vtt');

    await act(async () => {
      first.reject(new Error('boom'));
      await first.promise.catch(() => undefined);
    });

    expect(result.current.status).toBe('error');
    expect(first.signal.aborted).toBe(false);

    const thumbnails = [{ fromMs: 0, toMs: 1000, url: 'inline.jpg' }];
    rerender({ source: thumbnails });

    expect(first.signal.aborted).toBe(true);
    expect(result.current).toMatchObject({
      thumbnails,
      status: 'loaded',
      error: undefined,
    });
  });

  it('immediately discards an in-flight request and failure state when cleared', async () => {
    const deferred = deferredResponse();
    const { rerender, result } = renderUse('/media/a.vtt');

    await act(async () => {
      deferred.reject(new Error('boom'));
      await deferred.promise.catch(() => undefined);
    });
    expect(result.current.status).toBe('error');

    rerender({ source: undefined });

    expect(deferred.signal.aborted).toBe(true);
    expect(result.current).toMatchObject({
      thumbnails: undefined,
      status: 'loaded',
      error: undefined,
    });
  });

  it('starts a fresh session when switching back from an array to a string', async () => {
    const thumbnails = [{ fromMs: 0, toMs: 1000, url: 'inline.jpg' }];
    const { rerender, result } = renderUse(thumbnails);

    const deferred = deferredResponse();
    rerender({ source: '/media/b.vtt' });

    expect(result.current).toMatchObject({ status: 'loading' });

    await act(async () => {
      deferred.resolve(new Response(VTT_B));
      await deferred.promise;
    });

    expect(result.current.status).toBe('loaded');
    expect(result.current.thumbnails?.[0].url).toContain('sheet-b.jpg');
  });

  it('aborts the request on unmount', () => {
    const deferred = deferredResponse();
    const { unmount } = renderUse('/media/a.vtt');

    unmount();

    expect(deferred.signal.aborted).toBe(true);
  });
});
