// The Player and settings modules were written for the browser; these globals let
// them load under Node so the audio wiring can be exercised without a DOM.
const store = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, String(value)),
		removeItem: (key: string) => store.delete(key),
		clear: () => store.clear(),
	},
});

Object.defineProperty(globalThis, "addEventListener", {
	configurable: true,
	writable: true,
	value: () => {},
});

export {};
