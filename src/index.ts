const USER_INPUT_EVENTS = [
    'pointerdown',
    'pointerup',
    'touchstart',
    'touchend',
    'mousedown',
    'mouseup',
    'click',
    'keydown',
];

const LISTENER_OPTIONS = { capture: true, passive: true };

export interface WebAudioUnlockOptions
{
    /**
     * Maximum time in milliseconds to wait for a user gesture,
     * counted from the moment the gesture listeners are registered.
     * On timeout all listeners are removed and the returned promise
     * is rejected with an error prefixed with 'webAudioUnlock:'.
     */
    timeoutMs?: number;

    /**
     * An AbortSignal that, once aborted, removes all listeners and
     * rejects the returned promise.
     */
    signal?: AbortSignal;
}

function isValidAudioContext (context: AudioContext): boolean
{
    return !!context
        && typeof context.resume === 'function'
        && typeof context.createBufferSource === 'function'
        && typeof context.state === 'string';
}

function createUnlockSound (context: AudioContext): void
{
    const source = context.createBufferSource();

    source.buffer = context.createBuffer(1, 1, 22050);
    source.connect(context.destination);
    source.onended = () =>
    {
        source.disconnect();
    };

    if (typeof source.start === 'function')
    {
        source.start(0);
    }
    else if (typeof (source as any).noteOn === 'function')
    {
        (source as any).noteOn(0);
    }
}

export default function webAudioUnlock (
    context: AudioContext,
    options: WebAudioUnlockOptions = {}
): Promise<boolean>
{
    return new Promise <boolean>((resolve, reject) =>
    {
        if (!context || !isValidAudioContext(context))
        {
            reject(new Error('webAudioUnlock: invalid AudioContext'));
            return;
        }

        if (context.state === 'running')
        {
            resolve(false);

            return;
        }

        const timeoutMs = options.timeoutMs;
        const signal = options.signal;

        let settled = false;
        let isUnlocking = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        function toggleListeners (operation: 'add' | 'remove'): void
        {
            const method = operation + 'EventListener' as
                'addEventListener' | 'removeEventListener';

            for (let i = 0; i < USER_INPUT_EVENTS.length; i++)
            {
                document[method](USER_INPUT_EVENTS[i], unlock, LISTENER_OPTIONS);
            }
        }

        function cleanup (): void
        {
            toggleListeners('remove');

            if (timeoutId !== undefined)
            {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }

            if (signal)
            {
                signal.removeEventListener('abort', onAbort);
            }
        }

        function settleResolve (value: boolean): void
        {
            if (settled)
            {
                return;
            }
            settled = true;

            cleanup();

            resolve(value);
        }

        function settleReject (error: Error): void
        {
            if (settled)
            {
                return;
            }
            settled = true;

            cleanup();

            reject(error);
        }

        function onAbort (): void
        {
            const error = new Error('webAudioUnlock: aborted by the provided AbortSignal');
            error.name = 'AbortError';

            settleReject(error);
        }

        function unlock (): void
        {
            if (settled || isUnlocking)
            {
                return;
            }
            isUnlocking = true;

            createUnlockSound(context);

            context.resume().then(() =>
            {
                // A timeout or abort may have settled the promise while
                // resume() was pending; late callbacks must not settle again.
                if (settled)
                {
                    return;
                }

                if (context.state === 'running')
                {
                    settleResolve(true);

                    return;
                }

                settleReject(new Error(
                    'webAudioUnlock: resume() succeeded but AudioContext state is still "'
                    + context.state + '"'
                ));
            }
            ).catch(() =>
            {
                if (settled)
                {
                    return;
                }

                // resume() rejected; allow the next gesture to retry.
                isUnlocking = false;
            });
        }

        if (signal)
        {
            if (signal.aborted)
            {
                onAbort();

                return;
            }

            signal.addEventListener('abort', onAbort);
        }

        if (timeoutMs !== undefined)
        {
            timeoutId = setTimeout(() =>
            {
                settleReject(new Error(
                    'webAudioUnlock: timeout after ' + timeoutMs + 'ms waiting for a user gesture'
                ));
            }, timeoutMs);
        }

        toggleListeners('add');
    });
}
