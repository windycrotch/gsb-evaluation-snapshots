import { isConnectionReplaced } from '../wss.ts';
import type { WSS } from '../wss.ts';

// how long to wait for the editor to reload and reconnect after a reloading op.
// the reconnect fires on the reloaded page's DOMContentLoaded (before assets stream in),
// so this scales with page render/network, not project size.
const RELOAD_WAIT_MS = 60_000;

/**
 * Fire a method that reloads the editor, wait for it to reconnect, then return the follow-up
 * query, so the agent sees one clean call across the reload.
 *
 * The chain is generation-based: capture the editor connection generation, fire
 * the op, then accept only a NEWER editor connection as proof the reload took
 * effect. If the old connection is replaced before it answers the op itself,
 * that cancellation IS the reload starting, not a failure.
 *
 * @param wss - The websocket bridge.
 * @param follow - The follow-up method and the tool to suggest if the editor never returns; null to return the op's own result instead.
 * @param follow.method - The method queried on the reconnected editor.
 * @param follow.tool - The tool that runs the same query.
 * @param method - The reloading method.
 * @param args - Its arguments.
 * @param waitMs - How long to wait for the reconnect.
 * @returns The follow-up query's response (or the op's own result when `follow` is null), or an error if the editor didn't reconnect.
 */
const withReload = async (wss: WSS, follow: { method: string; tool: string } | null, method: string, args: unknown[], waitMs = RELOAD_WAIT_MS) => {
    const gen = wss.editorGeneration;
    let res;
    try {
        res = await wss.raw(method, ...args);
    } catch (err) {
        // the editor reloaded before it could answer — that is the reload we
        // are waiting for, so don't report it as a failure
        if (!isConnectionReplaced(err)) {
            return wss.fail(method, err instanceof Error ? err.message : String(err));
        }
        res = null;
    }
    if (res?.error) {
        return wss.fail(method, res.error);
    }
    const back = await wss.waitForEditor(gen, waitMs);
    if (!back) {
        const retry = follow ? `call ${follow.tool}` : 'retry';
        return wss.fail(method, `Operation issued but the editor did not reconnect in time. Check the editor is open and connected, then ${retry}.`);
    }
    return follow ? wss.call(follow.method) : wss.ok(method, res?.data ?? null, res?.meta);
};

export { withReload, RELOAD_WAIT_MS };
