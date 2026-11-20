import { defineConfig, type Plugin } from 'vitest/config';

const headed = process.env.HEADED === 'true';

/**
 * Test-only endpoints for the "unmount while a remote shader is still fetching" case.
 * `/__test/hang.glsl` stays pending until `/__test/release` is requested, so a test can
 * unmount a component mid-initialization and then deliver the late result deterministically.
 */
function shaderGatePlugin(): Plugin {
	let releaseGate: (() => void) | null = null;
	const shaderSource = `precision mediump float;
void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }`;
	return {
		name: 'test-shader-gate',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const pathname = req.url?.split('?')[0];
				if (pathname === '/__test/hang.glsl') {
					new Promise<void>((resolve) => {
						releaseGate = resolve;
					}).then(() => {
						res.setHeader('content-type', 'text/plain');
						res.end(shaderSource);
					});
					return;
				}
				if (pathname === '/__test/release') {
					releaseGate?.();
					releaseGate = null;
					res.end('ok');
					return;
				}
				next();
			});
		},
	};
}

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				plugins: [shaderGatePlugin()],
				test: {
					name: 'browser',
					include: ['tests/browser/**/*.test.ts'],
					browser: {
						enabled: true,
						provider: 'playwright',
						// headless: false → Playwright uses the full Chromium binary (WebGL support)
						// instead of Chrome Headless Shell (no WebGL). The --headless=new arg
						// passed below makes Chrome run without a visible window.
						headless: false,
						instances: [
							{
								browser: 'chromium',
								launch: {
									args: [
										// omit --headless=new when HEADED=true to get a visible window
										...(headed ? [] : ['--headless=new']),
										'--no-sandbox',
										'--disable-setuid-sandbox',
										'--enable-webgl',
										'--use-gl=angle',
									],
								},
							},
						],
					},
				},
			},
		],
	},
});
