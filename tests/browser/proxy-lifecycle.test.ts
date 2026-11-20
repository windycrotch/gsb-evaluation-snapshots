import { describe, expect, it } from 'vitest';
import { DEFAULT_FS_SHADER, DEFAULT_VS_SHADER } from '../../src/defaults';
import { WebGLManagerProxy, WebGLManagerProxyType } from '../../src/offscreen-webgl/proxy';

describe('WebGLManagerProxy lifecycle', () => {
	it('destroy is idempotent and safe before initialization completes', async () => {
		const proxy = new WebGLManagerProxy(document.createElement('canvas'));
		// Repeated unmounts and unready unmounts must not throw.
		expect(() => proxy.destroy()).not.toThrow();
		expect(() => proxy.destroy()).not.toThrow();
		await expect(proxy.destroyAsync()).resolves.toBeNull();
		await expect(proxy.destroyAsync()).resolves.toBeNull();
		// Late calls on a destroyed proxy reject instead of touching a released manager.
		await expect(proxy.setVertexShaderAsync(DEFAULT_VS_SHADER)).rejects.toThrow();
	});

	it('a destroy interleaved with async work never resurrects the manager', async () => {
		const proxy = new WebGLManagerProxy(document.createElement('canvas')) as WebGLManagerProxyType;
		await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
		await proxy.setFragmentShadersAsync([DEFAULT_FS_SHADER]);
		await proxy.setupWholeScreenQuadAsync();

		// Calls issued before destroy resolve normally because the worker serializes each
		// proxy's queue; destroy only takes effect once they have been handled.
		const inFlight = proxy.runOnContextAsync('value', () => 42);
		proxy.destroy();
		await expect(inFlight).resolves.toBe(42);

		// Repeated destroy calls are idempotent, and any late call rejects because the
		// manager no longer exists instead of silently recreating it.
		await expect(proxy.destroyAsync()).resolves.toBeNull();
		await expect(proxy.destroyAsync()).resolves.toBeNull();
		await expect(proxy.paintCanvasAsync()).rejects.toThrow();

		// A brand-new proxy on the same shared worker initializes and renders normally.
		const other = new WebGLManagerProxy(document.createElement('canvas'));
		try {
			await other.setVertexShaderAsync(DEFAULT_VS_SHADER);
			await other.setFragmentShadersAsync([DEFAULT_FS_SHADER]);
			await other.setupWholeScreenQuadAsync();
			await other.updateUniformAsync('u_resolution', [4, 4]);
			await expect(other.resizeAsync(4, 4)).resolves.toBeNull();
			await expect(other.paintCanvasAsync()).resolves.toBeNull();
		} finally {
			await other.destroyAsync();
		}
	});

	it('two proxies destroy independently without taking the shared worker down', async () => {
		const first = new WebGLManagerProxy(document.createElement('canvas'));
		const second = new WebGLManagerProxy(document.createElement('canvas'));
		await Promise.all([first.setVertexShaderAsync(DEFAULT_VS_SHADER), second.setVertexShaderAsync(DEFAULT_VS_SHADER)]);
		await Promise.all([first.setFragmentShadersAsync([DEFAULT_FS_SHADER]), second.setFragmentShadersAsync([DEFAULT_FS_SHADER])]);
		await Promise.all([first.setupWholeScreenQuadAsync(), second.setupWholeScreenQuadAsync()]);

		await first.destroyAsync();
		await first.destroyAsync();

		// The surviving proxy keeps working after the first one is gone.
		await expect(second.updateUniformAsync('u_resolution', [4, 4])).resolves.toBeNull();
		await expect(second.resizeAsync(4, 4)).resolves.toBeNull();
		await expect(second.paintCanvasAsync()).resolves.toBeNull();
		await second.destroyAsync();
	});
});
