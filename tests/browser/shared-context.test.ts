import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VS_SHADER } from '../../src/defaults';
import { WebGLManagerProxy } from '../../src/offscreen-webgl/proxy';

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

/** Assert a pixel is within ±tolerance of the expected RGBA values. */
function expectPixelNear(actual: number[], expected: number[], tolerance = 2) {
	for (let i = 0; i < 4; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(
			tolerance,
			`channel ${i}: got [${actual}], expected [${expected}] ±${tolerance}`
		);
	}
}

/**
 * The gradient shader outputs `gl_FragCoord.xy / u_resolution`, so the pixel at
 * canvas-2D coordinates (x, y) — y measured from the top — corresponds to
 * gl_FragCoord (x + 0.5, height - y - 0.5).
 */
function expectGradientPixel(canvas: HTMLCanvasElement, width: number, height: number, x: number, y: number) {
	expectPixelNear(pixel(canvas, x, y), [Math.round(((x + 0.5) / width) * 255), Math.round(((height - y - 0.5) / height) * 255), 0, 255]);
}

/** Check the bottom-left and top-right corners of a gradient canvas of the given size. */
function expectGradientCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
	expect([canvas.width, canvas.height]).toEqual([width, height]);
	expectGradientPixel(canvas, width, height, 0, height - 1);
	expectGradientPixel(canvas, width, height, width - 1, 0);
}

describe('shared worker context', () => {
	it('renders 20 canvases mixing sizes and single-/two-pass shaders on one shared context', async () => {
		const sizes: [number, number][] = [
			[4, 4],
			[16, 2],
			[2, 16],
		];
		const sizeOf = (index: number) => sizes[index % sizes.length];
		const isTwoPass = (index: number) => index % 2 === 1;
		const canvases = Array.from({ length: 20 }, (_, index) => {
			const canvas = document.createElement('canvas');
			const [width, height] = sizeOf(index);
			canvas.width = width;
			canvas.height = height;
			return canvas;
		});
		const proxies = canvases.map((canvas) => new WebGLManagerProxy(canvas));
		const expectOwnPixels = (index: number) => {
			const [width, height] = sizeOf(index);
			if (isTwoPass(index)) expectPixelNear(pixel(canvases[index], width >> 1, height >> 1), [0, 0, 255, 255]);
			else expectGradientCanvas(canvases[index], width, height);
		};
		const destroyed = new Set<number>();
		try {
			await Promise.all(
				proxies.map(async (proxy, index) => {
					const [width, height] = sizeOf(index);
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					if (isTwoPass(index)) await proxy.setFragmentShaderGroupsAsync([[red], [blueFromRed]]);
					else await proxy.setFragmentShadersAsync([gradient]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [width, height]);
					await proxy.resizeAsync(width, height);
				})
			);
			// Repaint everything now that the shared canvas has reached its final
			// size — growing it clears the shared drawing buffer.
			await Promise.all(proxies.map((proxy) => proxy.paintCanvasAsync()));
			await vi.waitFor(() => {
				for (let index = 0; index < canvases.length; index++) expectOwnPixels(index);
			});

			// All proxies share a single WebGL context inside the worker.
			await proxies[0].runOnContextAsync('save', (manager) => {
				(globalThis as any).sharedTestContext = manager.getGLContext();
			});
			await expect(
				proxies[19].runOnContextAsync('compare', (manager) => manager.getGLContext() === (globalThis as any).sharedTestContext)
			).resolves.toBe(true);

			// An invalid shader rejects with an error and leaves the other canvases intact.
			await expect(proxies[19].setFragmentShadersAsync(['invalid shader'])).rejects.toThrow('compile Fragment Shader');
			await proxies[18].paintCanvasAsync();
			await proxies[19].paintCanvasAsync();
			await vi.waitFor(() => {
				expectOwnPixels(18);
				expectOwnPixels(19);
			});

			// Destroying one canvas — here a two-pass one — must not disturb the rest.
			await proxies[1].destroyAsync();
			destroyed.add(1);
			await Promise.all(proxies.filter((_, index) => index !== 1).map((proxy) => proxy.paintCanvasAsync()));
			await vi.waitFor(() => {
				for (let index = 0; index < canvases.length; index++) if (index !== 1) expectOwnPixels(index);
			});
		} finally {
			await Promise.all(proxies.filter((_, index) => !destroyed.has(index)).map((proxy) => proxy.destroyAsync()));
		}
	});

	it('presents the right region when canvases of different sizes share the context', async () => {
		const sizes: [number, number][] = [
			[4, 4],
			[16, 2],
			[2, 16],
		];
		const canvases = sizes.map(() => document.createElement('canvas'));
		const proxies = canvases.map((canvas) => new WebGLManagerProxy(canvas));
		try {
			await Promise.all(
				proxies.map(async (proxy, index) => {
					const [width, height] = sizes[index];
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					await proxy.setFragmentShadersAsync([gradient]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [width, height]);
					await proxy.resizeAsync(width, height);
				})
			);
			await proxies[0].paintCanvasAsync();
			await vi.waitFor(() => {
				expect([canvases[0].width, canvases[0].height]).toEqual([4, 4]);
				expect(pixel(canvases[0], 0, 3)).toEqual([32, 32, 0, 255]);
				expect(pixel(canvases[0], 3, 0)).toEqual([223, 223, 0, 255]);
				expect(pixel(canvases[1], 15, 0)).toEqual([247, 191, 0, 255]);
				expect(pixel(canvases[2], 0, 15)).toEqual([64, 8, 0, 255]);
			});
		} finally {
			await Promise.all(proxies.map((proxy) => proxy.destroyAsync()));
		}
	});

	it('resizes the output canvas and keeps its own pixels when a canvas changes size', async () => {
		const canvases = [document.createElement('canvas'), document.createElement('canvas')];
		const proxies = canvases.map((canvas) => new WebGLManagerProxy(canvas));
		try {
			for (const proxy of proxies) {
				await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
				await proxy.setFragmentShadersAsync([gradient]);
				await proxy.setupWholeScreenQuadAsync();
				await proxy.updateUniformAsync('u_resolution', [4, 4]);
				await proxy.resizeAsync(4, 4);
			}
			await vi.waitFor(() => expectGradientCanvas(canvases[1], 4, 4));

			// Grow the first canvas beyond the current shared canvas size: the shared
			// canvas is resized (clearing it) and the output canvas must follow.
			await proxies[0].updateUniformAsync('u_resolution', [12, 12]);
			await proxies[0].resizeAsync(12, 12);
			await vi.waitFor(() => expectGradientCanvas(canvases[0], 12, 12));

			// The other canvas still presents its own 4×4 gradient from the shared canvas.
			await proxies[1].paintCanvasAsync();
			await vi.waitFor(() => expectGradientCanvas(canvases[1], 4, 4));

			// Shrinking works too: the output canvas tracks the new size.
			await proxies[0].updateUniformAsync('u_resolution', [2, 2]);
			await proxies[0].resizeAsync(2, 2);
			await vi.waitFor(() => expectGradientCanvas(canvases[0], 2, 2));
			await proxies[1].paintCanvasAsync();
			await vi.waitFor(() => expectGradientCanvas(canvases[1], 4, 4));
		} finally {
			await Promise.all(proxies.map((proxy) => proxy.destroyAsync()));
		}
	});
});
