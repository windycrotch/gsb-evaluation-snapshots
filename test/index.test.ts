import { test } from 'node:test';
import assert from 'node:assert/strict';

import webAudioUnlock from '../src/index.ts';

type Listener = (event?: unknown)=> void;

interface FakeDocument
{
    addEventListener: (type: string, listener: Listener, options?: unknown)=> void;
    removeEventListener: (type: string, listener: Listener, options?: unknown)=> void;
    dispatch: (type: string)=> void;
    listenerCount: ()=> number;
}

function createFakeDocument (): FakeDocument
{
    const listeners = new Map<string, Set<Listener>>();

    return {
        addEventListener (type, listener)
        {
            let set = listeners.get(type);

            if (!set)
            {
                set = new Set();
                listeners.set(type, set);
            }

            set.add(listener);
        },

        removeEventListener (type, listener)
        {
            listeners.get(type)?.delete(listener);
        },

        dispatch (type)
        {
            const matching = listeners.get(type);

            if (!matching)
            {
                return;
            }

            const snapshot: Listener[] = [];

            matching.forEach((listener) =>
            {
                snapshot.push(listener);
            });

            for (const listener of snapshot)
            {
                listener({ type });
            }
        },

        listenerCount ()
        {
            let count = 0;

            listeners.forEach((set) =>
            {
                count += set.size;
            });

            return count;
        },
    };
}

interface FakeAudioContext
{
    state: string;
    destination: object;
    sourcesCreated: number;
    resumeCalls: number;
    createBuffer: ()=> object;
    createBufferSource: ()=> object;
    resume: ()=> Promise<void>;
    resolveNextResume: (newState?: string)=> void;
    rejectNextResume: (error: Error)=> void;
    pendingResumeCount: ()=> number;
}

function createFakeAudioContext (state = 'suspended'): FakeAudioContext
{
    const pendingResumes: Array<{
        resolve: ()=> void;
        reject: (error: Error)=> void;
    }> = [];

    const context: FakeAudioContext = {
        state,
        destination: {},
        sourcesCreated: 0,
        resumeCalls: 0,

        createBuffer ()
        {
            return {};
        },

        createBufferSource ()
        {
            context.sourcesCreated++;

            return {
                buffer: null,
                onended: null,
                connect () { /* noop */ },
                disconnect () { /* noop */ },
                start () { /* noop */ },
            };
        },

        resume ()
        {
            context.resumeCalls++;

            return new Promise<void>((resolve, reject) =>
            {
                pendingResumes.push({ resolve, reject });
            });
        },

        resolveNextResume (newState = 'running')
        {
            const pending = pendingResumes.shift();

            assert.ok(pending, 'expected a pending resume() call');

            context.state = newState;
            pending.resolve();
        },

        rejectNextResume (error)
        {
            const pending = pendingResumes.shift();

            assert.ok(pending, 'expected a pending resume() call');

            pending.reject(error);
        },

        pendingResumeCount ()
        {
            return pendingResumes.length;
        },
    };

    return context;
}

const flush = () => new Promise<void>((resolve) =>
{
    setImmediate(resolve);
});

function withFakeDocument (fn: (fakeDocument: FakeDocument)=> Promise<void>)
{
    return async () =>
    {
        const fakeDocument = createFakeDocument();
        const globalScope = globalThis as Record<string, unknown>;
        const originalDocument = globalScope.document;

        globalScope.document = fakeDocument;

        try
        {
            await fn(fakeDocument);
        }
        finally
        {
            if (originalDocument === undefined)
            {
                delete globalScope.document;
            }
            else
            {
                globalScope.document = originalDocument;
            }
        }
    };
}

void test('resolves true after a gesture unlocks the context and removes listeners',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();

        const promise = webAudioUnlock(context as never);

        assert.ok(fakeDocument.listenerCount() > 0, 'gesture listeners registered');

        fakeDocument.dispatch('pointerdown');

        assert.equal(context.sourcesCreated, 1);
        assert.equal(context.resumeCalls, 1);

        context.resolveNextResume('running');

        assert.equal(await promise, true);
        assert.equal(fakeDocument.listenerCount(), 0, 'all listeners removed');
    }));

void test('resolves false immediately when the context is already running',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext('running');

        const promise = webAudioUnlock(context as never);

        assert.equal(await promise, false);
        assert.equal(fakeDocument.listenerCount(), 0, 'no listeners registered');
        assert.equal(context.resumeCalls, 0);
    }));

void test('rejects on an invalid AudioContext', withFakeDocument(async () =>
{
    await assert.rejects(
        // @ts-expect-error intentionally invalid argument
        webAudioUnlock(null),
        /^Error: webAudioUnlock: invalid AudioContext$/
    );

    await assert.rejects(
        webAudioUnlock({} as never),
        /^Error: webAudioUnlock: invalid AudioContext$/
    );
}));

void test('rejects on timeout and removes all listeners', withFakeDocument(async (fakeDocument) =>
{
    const context = createFakeAudioContext();

    const promise = webAudioUnlock(context as never, { timeoutMs: 20 });

    await assert.rejects(
        promise,
        /^Error: webAudioUnlock: timeout after 20ms/
    );

    assert.equal(fakeDocument.listenerCount(), 0, 'all listeners removed after timeout');
    assert.equal(context.sourcesCreated, 0, 'no unlock sound created without a gesture');
}));

void test('rejects immediately when the signal is already aborted',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();
        const controller = new AbortController();

        controller.abort();

        const promise = webAudioUnlock(context as never, { signal: controller.signal });

        await assert.rejects(promise, /webAudioUnlock: aborted/);
        assert.equal(fakeDocument.listenerCount(), 0, 'no listeners registered');
    }));

void test('rejects when aborted mid-unlock and ignores the late resume callback',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();
        const controller = new AbortController();

        const promise = webAudioUnlock(context as never, { signal: controller.signal });

        fakeDocument.dispatch('pointerdown');

        assert.equal(context.resumeCalls, 1);

        controller.abort();

        await assert.rejects(promise, /webAudioUnlock: aborted/);
        assert.equal(fakeDocument.listenerCount(), 0, 'all listeners removed after abort');

        // The resume() promise resolves after the abort; it must not
        // settle the already-rejected promise again.
        context.resolveNextResume('running');

        await flush();

        assert.equal(context.pendingResumeCount(), 0);
    }));

void test('rejects when resume() succeeds but the state is still not running',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();

        const promise = webAudioUnlock(context as never);

        fakeDocument.dispatch('pointerdown');
        context.resolveNextResume('suspended');

        await assert.rejects(
            promise,
            /^Error: webAudioUnlock: resume\(\) succeeded but AudioContext state is still "suspended"$/
        );

        assert.equal(fakeDocument.listenerCount(), 0, 'all listeners removed');
    }));

void test('ignores repeated gestures while an unlock attempt is in flight',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();

        const promise = webAudioUnlock(context as never);

        fakeDocument.dispatch('pointerdown');
        fakeDocument.dispatch('mousedown');
        fakeDocument.dispatch('keydown');

        assert.equal(context.sourcesCreated, 1, 'only one unlock sound created');
        assert.equal(context.resumeCalls, 1, 'resume() called only once');

        context.resolveNextResume('running');

        assert.equal(await promise, true);
    }));

void test('settles only once when timeout and abort fire together',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();
        const controller = new AbortController();

        const promise = webAudioUnlock(context as never, {
            timeoutMs: 20,
            signal: controller.signal,
        });

        controller.abort();

        await assert.rejects(promise, /webAudioUnlock: aborted/);

        // Let the (already cleared) timeout window pass; nothing else may happen.
        await new Promise<void>((resolve) =>
        {
            setTimeout(resolve, 50);
        });

        assert.equal(fakeDocument.listenerCount(), 0);
    }));

void test('allows retrying with the next gesture after resume() rejects',
    withFakeDocument(async (fakeDocument) =>
    {
        const context = createFakeAudioContext();

        const promise = webAudioUnlock(context as never);

        fakeDocument.dispatch('pointerdown');
        context.rejectNextResume(new Error('resume failed'));

        await flush();

        assert.ok(fakeDocument.listenerCount() > 0, 'listeners kept for the next gesture');

        fakeDocument.dispatch('keydown');

        assert.equal(context.resumeCalls, 2, 'resume() retried on the next gesture');

        context.resolveNextResume('running');

        assert.equal(await promise, true);
    }));
