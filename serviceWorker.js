"use strict";

const DAW_CACHE = "daw";
// Versioned startup scripts: the page loads them as one consistent group
// (either all from the network or all from the cache), so the service worker
// must never mix versions by silently falling back to the cache per request.
const DAW_STARTUP_SCRIPTS = [
	"/assets/gsuiLibrarySamples-v1.js",
	"/assets/gsuiWaveletList-v1.js",
];

self.addEventListener( "install", e => {
	e.waitUntil( caches.open( DAW_CACHE ).then( cache =>
		cache.addAll( [
			"/",
			"/index.html",
			"/manifest.json",
			"/assets/ico.svg",
			"/assets/logo/gs-gs-logo.svg",
			"/assets/logo/gs-gridsound-logo-animated.svg",
			"/assets/gsuiLibrarySamples-v1.js",
			"/assets/gsuiWaveletList-v1.js",
			"/assets/gswaPeriodicWavesList-v1.js",
			"/assets/fonts/fa-brands-400.woff2",
			"/assets/fonts/fa-duotone-900.woff2",
			"/assets/fonts/unica-one-400-latin.woff2",
			"/assets/fonts/montserrat-500-latin.woff2",
			"/assets/fonts/montserrat-700-latin.woff2",
			"/assets/fonts/inconsolata-400-latin.woff2",
		] )
	) );
} );

self.addEventListener( "fetch", e => {
	const pathname = new URL( e.request.url ).pathname;

	if ( DAW_STARTUP_SCRIPTS.includes( pathname ) ) {
		// Network only: on failure the page falls back to the cache for the
		// whole script group at once, never for a single file. Successful
		// responses refresh the cached copy used by the offline fallback.
		e.respondWith(
			fetch( e.request ).then( res => {
				if ( res.ok ) {
					const res2 = res.clone();

					caches.open( DAW_CACHE ).then( c => c.put( e.request, res2 ) );
				}
				return res;
			} )
		);
		return;
	}
	e.respondWith(
		fetch( e.request ).catch( () => caches.match( e.request ) )
	);
} );
