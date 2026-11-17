import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VS_SHADER } from '../../src/defaults';
import { WorkerMessageType, WorkerMessages } from '../../src/offscreen-webgl/webgl.worker';
import WebWorker from '../../src/offscreen-webgl/webgl.worker?worker';

const gradient = `precision mediump float;
uniform vec2 u_resolution;
void main() { gl_FragColor = vec4(gl_FragCoord.xy / u_resolution, 0.0, 1.0); }`;
const red = 'precision mediump float; void main() { gl_FragColor = vec4(1., 0., 0., 1.); }';
const blueFromRed = `precision mediump float;
uniform sampler2D u_buffer0;
void main() { gl_FragColor = vec4(0., 0., texture2D(u_buffer0, vec2(.5)).r, 1.); }`;

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const copy = document.createElement('canvas');
	copy.width = canvas.width;
	copy.height = canvas.height;
	const context = copy.getContext('2d')!;
	context.drawImage(canvas, 0, 0);
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

/**
 * Drives a dedicated worker with raw INIT / CALL_METHOD / RELEASE messages —
 * the same messages the proxy sends — to verify the worker-side presentation
 * in isolation (the proxy's static worker is shared across the test file).
 */
describe('shared worker RELEASE handling', () => {
	it('releasing one canvas does not affect the surviving canvases', async () => {
		const worker: Worker = new WebWorker();
		const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		worker.onmessage = (event: MessageEvent<WorkerMessages>) => {
			const data = event.data;
			if (data.type !== WorkerMessageType.RESPONSE && data.type !== WorkerMessageType.ERROR) return;
			if (!('id' in data) || !data.id) return;
			const entry = pending.get(data.id);
			if (!entry) return;
			pending.delete(data.id);
			if (data.type === WorkerMessageType.ERROR) entry.reject(new Error((data as { error: string }).error));
			else entry.resolve((data as { result: any }).result);
		};
		let nextId = 0;
		const call = (proxyId: string, method: string, args: any[]) =>
			new Promise((resolve, reject) => {
				const id = `call-${nextId++}`;
				pending.set(id, { resolve, reject });
				worker.postMessage({ type: WorkerMessageType.CALL_METHOD, proxyId, method, args, id, async: true });
			});

		const canvasA = document.createElement('canvas');
		canvasA.width = 4;
		canvasA.height = 4;
		const canvasB = document.createElement('canvas');
		canvasB.width = 2;
		canvasB.height = 16;
		const offscreenA = canvasA.transferControlToOffscreen();
		const offscreenB = canvasB.transferControlToOffscreen();
		try {
			worker.postMessage(
				{ type: WorkerMessageType.INIT, proxyId: 'A', canvasId: 'canvas-a', output: offscreenA, width: 4, height: 4 },
				[offscreenA]
			);
			worker.postMessage(
				{ type: WorkerMessageType.INIT, proxyId: 'B', canvasId: 'canvas-b', output: offscreenB, width: 2, height: 16 },
				[offscreenB]
			);
			// A: two-pass shader group. B: single-pass gradient on a different size.
			await call('A', 'setVertexShader', [DEFAULT_VS_SHADER]);
			await call('A', 'setFragmentShaderGroups', [[[red], [blueFromRed]]]);
			await call('A', 'setupWholeScreenQuad', []);
			await call('A', 'updateUniform', ['u_resolution', [4, 4]]);
			await call('A', 'resize', [4, 4]);
			await call('B', 'setVertexShader', [DEFAULT_VS_SHADER]);
			await call('B', 'setFragmentShaders', [[gradient]]);
			await call('B', 'setupWholeScreenQuad', []);
			await call('B', 'updateUniform', ['u_resolution', [2, 16]]);
			await call('B', 'resize', [2, 16]);
			await vi.waitFor(() => {
				expect(pixel(canvasA, 2, 2)).toEqual([0, 0, 255, 255]);
				expect(pixel(canvasB, 0, 15)).toEqual([64, 8, 0, 255]);
			});

			// Release canvas A's output (the canvas element is gone). A's manager may
			// still paint — its frames go nowhere — and B must keep drawing correctly.
			worker.postMessage({ type: WorkerMessageType.RELEASE, canvasId: 'canvas-a' } satisfies WorkerMessages);
			await call('A', 'paintCanvas', []);
			await call('B', 'paintCanvas', []);
			await vi.waitFor(() => {
				expect([canvasB.width, canvasB.height]).toEqual([2, 16]);
				expect(pixel(canvasB, 0, 15)).toEqual([64, 8, 0, 255]);
				expect(pixel(canvasB, 1, 0)).toEqual([191, 247, 0, 255]);
			});

			// A brand-new canvas can still be initialised on the same worker afterwards.
			const canvasC = document.createElement('canvas');
			canvasC.width = 4;
			canvasC.height = 4;
			const offscreenC = canvasC.transferControlToOffscreen();
			worker.postMessage(
				{ type: WorkerMessageType.INIT, proxyId: 'C', canvasId: 'canvas-c', output: offscreenC, width: 4, height: 4 },
				[offscreenC]
			);
			await call('C', 'setVertexShader', [DEFAULT_VS_SHADER]);
			await call('C', 'setFragmentShaders', [[gradient]]);
			await call('C', 'setupWholeScreenQuad', []);
			await call('C', 'updateUniform', ['u_resolution', [4, 4]]);
			await call('C', 'resize', [4, 4]);
			await vi.waitFor(() => expect(pixel(canvasC, 0, 3)).toEqual([32, 32, 0, 255]));
		} finally {
			worker.terminate();
		}
	});
});
