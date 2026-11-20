import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffscreenWebGL } from '../../src/offscreen-webgl/offscreen-webgl';

const solid = (r: number, g: number, b: number) => `precision mediump float;
void main() { gl_FragColor = vec4(${r}.0, ${g}.0, ${b}.0, 1.0); }`;

// A data: URL is fetchable from inside the WebGL worker and carries the given GLSL,
// so the remote-shader code path is exercised without depending on test server routes.
const dataShaderURL = (source: string) => `data:text/plain,${encodeURIComponent(source)}`;

function pixel(canvas: HTMLCanvasElement): number[] {
	const copy = document.createElement('canvas');
	copy.width = canvas.width;
	copy.height = canvas.height;
	const context = copy.getContext('2d')!;
	context.drawImage(canvas, 0, 0);
	return Array.from(context.getImageData(0, 0, 1, 1).data);
}

function mountHarness() {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	return {
		container,
		root,
		unmount() {
			root.unmount();
			container.remove();
		},
	};
}

function wrapper(key: string, width: number, height: number, props: Record<string, unknown> = {}) {
	return createElement(
		'div',
		{ key, 'data-wrapper': key, style: { width: `${width}px`, height: `${height}px` } },
		createElement(OffscreenWebGL, props)
	);
}

async function waitForReady(container: HTMLElement, count: number): Promise<HTMLCanvasElement[]> {
	return vi.waitFor(() => {
		const canvases = Array.from(container.querySelectorAll('canvas'));
		expect(canvases.length).toBe(count);
		for (const canvas of canvases) {
			expect(canvas.dataset.error).toBe('false');
			expect(canvas.dataset.ready).toBe('true');
		}
		return canvases;
	});
}

describe('multiple OffscreenWebGL canvases', () => {
	let harness: { container: HTMLDivElement; root: Root; unmount: () => void };

	beforeEach(() => {
		harness = mountHarness();
	});

	afterEach(() => {
		harness.unmount();
	});

	it('initializes every canvas independently at its own DPR-scaled size', async () => {
		const dpr = window.devicePixelRatio;
		harness.root.render(
			createElement(
				'div',
				null,
				wrapper('a', 40, 20, { fragmentShader: solid(1, 0, 0) }),
				wrapper('b', 30, 25, { fragmentShader: solid(0, 0, 1) })
			)
		);

		const [canvasA, canvasB] = await waitForReady(harness.container, 2);

		expect([canvasA.width, canvasA.height]).toEqual([Math.round(40 * dpr), Math.round(20 * dpr)]);
		expect([canvasB.width, canvasB.height]).toEqual([Math.round(30 * dpr), Math.round(25 * dpr)]);

		// Each canvas renders its own shader output.
		await vi.waitFor(() => expect(pixel(canvasA)).toEqual([255, 0, 0, 255]));
		await vi.waitFor(() => expect(pixel(canvasB)).toEqual([0, 0, 255, 255]));
	});

	it('keeps a resize of one canvas isolated to that canvas', async () => {
		const dpr = window.devicePixelRatio;
		harness.root.render(createElement('div', null, wrapper('a', 40, 20), wrapper('b', 30, 25)));
		const [canvasA, canvasB] = await waitForReady(harness.container, 2);
		const sizeB: [number, number] = [canvasB.width, canvasB.height];
		expect(sizeB).toEqual([Math.round(30 * dpr), Math.round(25 * dpr)]);

		harness.container.querySelector('[data-wrapper="a"]')!.setAttribute('style', 'width: 64px; height: 20px');

		await vi.waitFor(() => expect(canvasA.width).toBe(Math.round(64 * dpr)));
		expect(canvasA.height).toBe(Math.round(20 * dpr));
		// The sibling keeps its own pixel size and stays ready.
		expect([canvasB.width, canvasB.height]).toEqual(sizeB);
		expect(canvasB.dataset.ready).toBe('true');
	});

	it('keeps rendering the surviving canvases after one canvas unmounts', async () => {
		harness.root.render(
			createElement(
				'div',
				null,
				wrapper('a', 8, 8, { fragmentShader: solid(1, 0, 0) }),
				wrapper('b', 8, 8, { fragmentShader: solid(0, 1, 0) }),
				wrapper('c', 8, 8, { fragmentShader: solid(0, 0, 1) })
			)
		);
		await waitForReady(harness.container, 3);

		harness.root.render(
			createElement(
				'div',
				null,
				wrapper('b', 8, 8, { fragmentShader: solid(0, 1, 0) }),
				wrapper('c', 8, 8, { fragmentShader: solid(0, 0, 1) })
			)
		);

		const survivors = await vi.waitFor(() => {
			const canvases = Array.from(harness.container.querySelectorAll('canvas'));
			expect(canvases.length).toBe(2);
			return canvases;
		});
		for (const canvas of survivors) expect(canvas.dataset.ready).toBe('true');
		await vi.waitFor(() => {
			const colors = survivors.map(pixel);
			expect(colors).toContainEqual([0, 255, 0, 255]);
			expect(colors).toContainEqual([0, 0, 255, 255]);
		});

		// A canvas mounted afterwards still reaches ready on the shared worker.
		harness.root.render(
			createElement(
				'div',
				null,
				wrapper('b', 8, 8, { fragmentShader: solid(0, 1, 0) }),
				wrapper('c', 8, 8, { fragmentShader: solid(0, 0, 1) }),
				wrapper('d', 8, 8, { fragmentShader: solid(1, 1, 0) })
			)
		);
		const yellow = await vi.waitFor(() => {
			const canvases = Array.from(harness.container.querySelectorAll('canvas'));
			expect(canvases.length).toBe(3);
			const last = canvases[2];
			expect(last.dataset.ready).toBe('true');
			return last;
		});
		await vi.waitFor(() => expect(pixel(yellow)).toEqual([255, 255, 0, 255]));
	});

	it('isolates a shader compile failure to the failing canvas and exposes its error', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			harness.root.render(
				createElement(
					'div',
					null,
					wrapper('a', 8, 8, { fragmentShader: 'this is not valid GLSL' }),
					wrapper('b', 8, 8, { fragmentShader: solid(0, 1, 0) })
				)
			);

			const [bad, good] = await vi.waitFor(() => {
				const canvases = Array.from(harness.container.querySelectorAll('canvas'));
				expect(canvases.length).toBe(2);
				return canvases;
			});

			await vi.waitFor(() => expect(bad.dataset.error).toBe('true'));
			expect(bad.dataset.ready).toBe('false');
			expect(bad.dataset.loading).toBe('false');
			expect(errorSpy).toHaveBeenCalled();
			expect(String(errorSpy.mock.calls.flat().find((arg) => arg instanceof Error))).toContain('Fragment Shader');

			expect(good.dataset.ready).toBe('true');
			expect(good.dataset.error).toBe('false');
			await vi.waitFor(() => expect(pixel(good)).toEqual([0, 255, 0, 255]));
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('isolates a remote shader fetch failure and leaves other canvases ready', async () => {
		harness.root.render(
			createElement(
				'div',
				null,
				// Same-origin path that does not exist: the worker fetch rejects with 404.
				wrapper('a', 8, 8, { fragmentShaderURL: '/__test/does-not-exist.glsl' }),
				wrapper('b', 8, 8, { fragmentShaderURL: dataShaderURL(solid(0, 0, 1)) })
			)
		);

		const [bad, good] = await vi.waitFor(() => {
			const canvases = Array.from(harness.container.querySelectorAll('canvas'));
			expect(canvases.length).toBe(2);
			return canvases;
		});

		await vi.waitFor(() => expect(bad.dataset.error).toBe('true'));
		expect(bad.dataset.ready).toBe('false');
		expect(good.dataset.ready).toBe('true');
		await vi.waitFor(() => expect(pixel(good)).toEqual([0, 0, 255, 255]));

		// The failed canvas must not poison later canvases on the same worker.
		harness.root.render(
			createElement(
				'div',
				null,
				wrapper('a', 8, 8, { fragmentShaderURL: '/__test/does-not-exist.glsl' }),
				wrapper('b', 8, 8, { fragmentShaderURL: dataShaderURL(solid(0, 0, 1)) }),
				wrapper('c', 8, 8, { fragmentShader: solid(1, 1, 0) })
			)
		);
		await vi.waitFor(() => {
			const canvases = Array.from(harness.container.querySelectorAll('canvas'));
			expect(canvases.length).toBe(3);
			expect(canvases[0].dataset.error).toBe('true');
			expect(canvases[1].dataset.ready).toBe('true');
			expect(canvases[2].dataset.ready).toBe('true');
		});
	});

	it('does not throw when an unready canvas unmounts and keeps the worker usable', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			// Mount and immediately unmount, before initialization can complete.
			harness.root.render(createElement('div', null, wrapper('short', 8, 8)));
			await vi.waitFor(() => expect(harness.container.querySelectorAll('canvas').length).toBe(1));
			harness.unmount();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(errorSpy).not.toHaveBeenCalled();

			// A subsequent canvas initializes normally on the same worker.
			const next = mountHarness();
			try {
				next.root.render(createElement('div', null, wrapper('next', 8, 8, { fragmentShader: solid(0, 1, 0) })));
				const [nextCanvas] = await waitForReady(next.container, 1);
				await vi.waitFor(() => expect(pixel(nextCanvas)).toEqual([0, 255, 0, 255]));
			} finally {
				next.unmount();
			}
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('never marks a canvas ready when it unmounts while a remote shader is still pending', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let gateReleased = false;
		const releaseGate = async () => {
			if (gateReleased) return;
			gateReleased = true;
			await fetch('/__test/release');
		};
		try {
			harness.root.render(createElement('div', null, wrapper('slow', 8, 8, { fragmentShaderURL: '/__test/hang.glsl' })));
			const slowCanvas = await vi.waitFor(() => {
				const canvas = harness.container.querySelector('canvas');
				expect(canvas).not.toBeNull();
				return canvas!;
			});
			await vi.waitFor(() => expect(slowCanvas.dataset.loading).toBe('true'));
			expect(slowCanvas.dataset.ready).toBe('false');

			// Unmount while the worker fetch is still pending.
			harness.unmount();
			expect(harness.container.querySelectorAll('canvas').length).toBe(0);

			// Deliver the late shader response after unmount; the late init result must not
			// resurrect the destroyed instance or surface as an error.
			await releaseGate();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(errorSpy).not.toHaveBeenCalled();

			// A fresh canvas on the same shared worker still initializes cleanly, proving
			// no stale manager or failure state was left behind.
			const next = mountHarness();
			try {
				next.root.render(createElement('div', null, wrapper('next', 8, 8, { fragmentShader: solid(0, 1, 0) })));
				const [nextCanvas] = await waitForReady(next.container, 1);
				await vi.waitFor(() => expect(pixel(nextCanvas)).toEqual([0, 255, 0, 255]));
			} finally {
				next.unmount();
			}
		} finally {
			// Always release the hanging route so afterEach's unmount never blocks on it.
			await releaseGate();
			errorSpy.mockRestore();
		}
	}, 15000);
});
