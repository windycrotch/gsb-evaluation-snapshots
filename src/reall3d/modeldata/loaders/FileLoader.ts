// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { OnFetching, OnFetchStart } from '../../events/EventConstants';
import { Events } from '../../events/Events';
import { LoadSession } from '../LoadSession';

/**
 * Download a whole file into memory.
 * Passing a load session makes the request abort (and the result unusable) as soon as the session is cancelled.
 */
export async function loadFile(url: string, events?: Events, session?: LoadSession): Promise<Uint8Array> {
    if (!url) return new Uint8Array(0);
    if (session && !session.isActive()) return null;

    const abortController: AbortController = new AbortController();
    const signal: AbortSignal = abortController.signal;
    const onSessionAbort = () => abortController.abort();
    session?.signal.addEventListener('abort', onSessionAbort, { once: true });
    try {
        events?.fire(OnFetchStart);
        const req = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload', signal });
        if (req.status != 200) {
            console.warn(`fetch error: ${req.status}`);
            return null;
        }
        const reader = req.body.getReader();
        const contentLength = parseInt(req.headers.get('content-length') || '0');
        const datas = new Uint8Array(contentLength);

        let bytesRead = 0;
        while (true) {
            if (session && !session.isActive()) return null;
            let { done, value } = await reader.read();
            if (done) break;
            datas.set(value, bytesRead);
            bytesRead += value.length;
            events?.fire(OnFetching, (100 * bytesRead) / contentLength);
        }
        return session && !session.isActive() ? null : datas;
    } catch (e) {
        if (e?.name === 'AbortError') {
            console.log('Fetch Abort', url);
        } else {
            console.error(e);
        }
        abortController.abort();
    } finally {
        session?.signal.removeEventListener('abort', onSessionAbort);
    }
    return null;
}
