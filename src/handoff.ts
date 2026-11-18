import net from 'node:net';

import { WebSocket } from 'ws';

/**
 * How an existing port owner responded to a handoff request.
 *
 * - `owner`: an MCP server answered the probe with `role: "owner"` and was asked to yield.
 * - `yielded`: the owner closed the probe connection after a yield frame, but no
 *   probe answer arrived (e.g. an older build that only understands `yield`).
 * - `none`: nothing accepted the connection, or the listener is not an MCP owner.
 * - `unanswered`: the listener accepted the connection but never answered or
 *   released it; the caller should stand by and keep retrying the bind.
 */
export type HandoffResult = 'owner' | 'yielded' | 'none' | 'unanswered';

/**
 * Ask whoever currently owns the editor bridge port to hand it over gracefully.
 *
 * The probe sends `{ hello: true }`; a current build answers with its role and,
 * when it owns the port, is asked to yield by a `{ yield: true }` frame. Older
 * builds ignore `hello`, so a yield frame is sent anyway after a short pause —
 * they understand that frame. No process is ever killed: if the owner ignores
 * both frames, the caller keeps stand-by retrying the bind instead.
 *
 * @param port - Loopback port the bridge listens on.
 * @param timeoutMs - Overall deadline for the exchange.
 * @returns How the owner responded.
 */
export const requestHandoff = (port: number, timeoutMs: number): Promise<HandoffResult> => {
    return new Promise<HandoffResult>((resolve) => {
        let settled = false;
        let sawOwner = false;
        let askedToYield = false;

        // no Origin: a local process, which is allowed to request a handoff
        const open = (): WebSocket | undefined => {
            try {
                return new WebSocket(`ws://127.0.0.1:${port}`);
            } catch {
                return undefined;
            }
        };
        const ws = open();
        if (!ws) {
            resolve('none');
            return;
        }

        const done = (result: HandoffResult) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                clearTimeout(probeTimer);
                resolve(result);
            }
        };

        const timer = setTimeout(() => {
            // we only learn about a yield through the socket closing; a silent
            // listener is not a yield, so keep standing by instead of assuming.
            done(sawOwner ? 'owner' : 'unanswered');
            try {
                ws.close();
            } catch { /* noop */ }
        }, timeoutMs);

        const yieldNow = () => {
            if (askedToYield || settled) {
                return;
            }
            askedToYield = true;
            try {
                ws.send(JSON.stringify({ yield: true }));
            } catch { /* noop */ }
        };

        // a current build answers the probe; an older one ignores it, so ask anyway.
        const probeTimer = setTimeout(yieldNow, Math.min(400, Math.floor(timeoutMs / 2)));

        ws.on('open', () => {
            try {
                ws.send(JSON.stringify({ hello: true }));
            } catch { /* noop */ }
        });
        ws.on('message', (data) => {
            if (settled) {
                return;
            }
            try {
                const msg = JSON.parse(data.toString());
                if (msg?.hello !== true) {
                    return;
                }
                clearTimeout(probeTimer);
                if (msg.role === 'owner') {
                    sawOwner = true;
                    yieldNow();
                } else {
                    done('none');
                }
            } catch {
                // not a handshake frame; ignore
            }
        });
        ws.on('close', () => {
            if (sawOwner) {
                done('owner');
            } else if (askedToYield) {
                done('yielded');
            } else {
                done('none');
            }
        });
        ws.on('error', (err: Error & { code?: string }) => {
            // ECONNREFUSED means nothing is listening; any other failure (e.g. an
            // HTTP server rejecting the upgrade) means a foreign listener is there.
            done(err?.code === 'ECONNREFUSED' ? 'none' : 'unanswered');
        });
    });
};

/**
 * Wait for the listening socket on `port` to disappear, so a bind after a handoff
 * does not race the previous owner's close. Polls with TCP connects rather than
 * PID tables, which are localized and unreliable.
 *
 * @param port - Loopback port to watch.
 * @param timeoutMs - Maximum time to wait.
 * @returns Resolves true once nothing is listening, false on timeout.
 */
export const waitForPortRelease = (port: number, timeoutMs: number): Promise<boolean> => {
    const refused = () => new Promise<boolean>((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const settle = (result: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.once('connect', () => settle(false));
        socket.once('error', () => settle(true));
    });
    const start = Date.now();
    return (async () => {
        while (Date.now() - start < timeoutMs) {
            if (await refused()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    })();
};
