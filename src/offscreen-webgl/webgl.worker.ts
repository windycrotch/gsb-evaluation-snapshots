import { uuidv4 } from '../utils/uuid';
import { WebGLManager } from './gl-manager';

export const WORKER_ID = `OffscreenWebGLWorker-${uuidv4()}`;

export enum WorkerMessageType {
	INIT = 'INIT',
	ERROR = 'ERROR',
	CALL_METHOD = 'CALL_METHOD',
	RESPONSE = 'RESPONSE',
	EVAL_FN = 'EVAL_FN',
	RELEASE = 'RELEASE',
	BATCH = 'BATCH',
}

export type WorkerMessages =
	| { proxyId: string; type: WorkerMessageType.INIT; canvasId: string; output?: OffscreenCanvas; width: number; height: number }
	| { type: WorkerMessageType.RELEASE; canvasId: string }
	| { type: WorkerMessageType.ERROR; id?: string; error: string }
	| { type: WorkerMessageType.CALL_METHOD; proxyId: string; id?: string; method: keyof WebGLManager; args: any[]; async?: boolean }
	| { type: WorkerMessageType.RESPONSE; id: string; result?: any; error?: string }
	| { type: WorkerMessageType.EVAL_FN; proxyId: string; key: string; id?: string; fn: string; onEachFrame?: boolean; async?: boolean }
	| { type: WorkerMessageType.BATCH; messages: WorkerMessages[] };

type Request = Extract<
	WorkerMessages,
	{ proxyId: string; type: WorkerMessageType.INIT | WorkerMessageType.CALL_METHOD | WorkerMessageType.EVAL_FN }
>;
const managers = new Map<string, WebGLManager>();
const failures = new Map<string, Error>();
const queues = new Map<string, Promise<void>>();
let sharedCanvas: OffscreenCanvas | undefined;
// Transferred output canvases, retained for the lifetime of the canvas element.
// A canvas transfers control at most once, so later proxies for the same element
// (e.g. React StrictMode remounts) re-acquire a 2D context from the stored canvas.
const outputCanvases = new Map<string, OffscreenCanvas>();
// Active presentation targets: an entry exists only while at least one live proxy
// references the canvas, so presentation stops as soon as the last proxy is destroyed.
const outputs = new Map<string, OffscreenCanvasRenderingContext2D>();
// Number of live proxies presenting into each output canvas. A canvas element can back
// more than one proxy over its lifetime (e.g. React StrictMode remounts), so the active
// output is only released once every proxy targeting it has been destroyed.
const outputRefCounts = new Map<string, number>();
// Maps each proxy to its output canvas, so destroy() can release exactly that proxy's
// output reference without knowing which canvas element it was created from.
const proxyOutputs = new Map<string, string>();

function present(canvasId: string, source: OffscreenCanvas, width: number, height: number): void {
	const output = outputs.get(canvasId);
	if (!output) return;
	const canvas = output.canvas;
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
		output.globalCompositeOperation = 'copy';
	}
	output.drawImage(source, 0, source.height - height, width, height, 0, 0, width, height);
}

function retainOutput(canvasId: string, transferred?: OffscreenCanvas): void {
	if (transferred) outputCanvases.set(canvasId, transferred);
	const canvas = transferred ?? outputCanvases.get(canvasId);
	if (!canvas) return;
	let output = outputs.get(canvasId);
	if (!output) {
		output = canvas.getContext('2d') ?? undefined;
		if (!output) throw new Error('2D canvas rendering is not supported');
		output.globalCompositeOperation = 'copy';
		outputs.set(canvasId, output);
	}
	outputRefCounts.set(canvasId, (outputRefCounts.get(canvasId) ?? 0) + 1);
}

function releaseOutput(canvasId: string): void {
	const refs = (outputRefCounts.get(canvasId) ?? 0) - 1;
	if (refs <= 0) {
		// Drop the active presentation target immediately; the transferred canvas
		// itself stays in `outputCanvases` until the RELEASE backstop fires.
		outputRefCounts.delete(canvasId);
		outputs.delete(canvasId);
	} else {
		outputRefCounts.set(canvasId, refs);
	}
}

/**
 * Destroys a proxy's manager and releases its output. Idempotent: destroying a proxy
 * that never finished initializing, was already destroyed, or whose manager is unknown
 * completes cleanly instead of throwing, so repeated/unready unmounts cannot crash the
 * shared worker or affect the other canvases it serves.
 */
function destroyProxy(proxyId: string): void {
	const manager = managers.get(proxyId);
	if (manager) {
		manager.destroy();
		managers.delete(proxyId);
	}
	failures.delete(proxyId);
	const canvasId = proxyOutputs.get(proxyId);
	if (canvasId) {
		proxyOutputs.delete(proxyId);
		releaseOutput(canvasId);
	}
}

async function handle(data: Request): Promise<void> {
	try {
		if (data.type === WorkerMessageType.INIT) {
			sharedCanvas ||= new OffscreenCanvas(data.width, data.height);
			const canvas = sharedCanvas;
			proxyOutputs.set(data.proxyId, data.canvasId);
			retainOutput(data.canvasId, data.output);
			const result = WebGLManager.fromHTMLCanvasElement(
				canvas as unknown as HTMLCanvasElement,
				data.width,
				data.height,
				(width, height) => present(data.canvasId, canvas, width, height)
			);
			if (result.error) throw result.error;
			managers.set(data.proxyId, result.data);
			failures.delete(data.proxyId);
			return;
		}

		if (data.type === WorkerMessageType.CALL_METHOD && data.method === 'destroy') {
			destroyProxy(data.proxyId);
			if (data.async && data.id) postMessage({ type: WorkerMessageType.RESPONSE, id: data.id, result: null });
			return;
		}

		const manager = managers.get(data.proxyId);
		if (!manager) throw failures.get(data.proxyId) || new Error(`WebGLManager not initialized for ${data.proxyId}`);
		let result: any;
		if (data.type === WorkerMessageType.CALL_METHOD) {
			const method = manager[data.method];
			if (typeof method !== 'function') throw new Error(`Method ${data.method} not found`);
			result = await (method as (...args: any[]) => any).apply(manager, data.args);
		} else {
			const fn = new Function('manager', 'frame', 'timeElapsed', `return (${data.fn})(manager, frame, timeElapsed);`);
			result = await manager.runOnContext(data.key, fn as any, data.onEachFrame);
		}

		if (data.type === WorkerMessageType.CALL_METHOD && result && typeof result === 'object' && 'error' in result && 'data' in result) {
			if (result.error) throw result.error;
			// Manager and WebGL objects cannot be cloned across the worker boundary.
			result = null;
		}
		if (data.async && data.id) postMessage({ type: WorkerMessageType.RESPONSE, id: data.id, result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (data.type === WorkerMessageType.INIT) {
			// INIT has no pending request on the main thread; remember the failure so the
			// next call on this proxy rejects, and roll back its output reservation.
			failures.set(data.proxyId, new Error(message));
			proxyOutputs.delete(data.proxyId);
			releaseOutput(data.canvasId);
			return;
		}
		postMessage({ type: WorkerMessageType.ERROR, id: 'id' in data ? data.id : undefined, error: message });
	}
}

function dispatch(data: WorkerMessages): void {
	if (data?.type === WorkerMessageType.BATCH) return data.messages.forEach(dispatch);
	if (data?.type === WorkerMessageType.RELEASE) {
		// Garbage-collection backstop: the canvas element is gone, so drop every
		// reservation for it unconditionally.
		outputRefCounts.delete(data.canvasId);
		outputs.delete(data.canvasId);
		outputCanvases.delete(data.canvasId);
		return;
	}
	if (!data || !('proxyId' in data)) return;
	const queue = (queues.get(data.proxyId) || Promise.resolve()).then(() => handle(data));
	queues.set(data.proxyId, queue);
	void queue.finally(() => {
		if (queues.get(data.proxyId) === queue) queues.delete(data.proxyId);
	});
}

addEventListener('message', (event: MessageEvent<WorkerMessages>) => dispatch(event.data));
