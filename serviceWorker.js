"use strict";

const CACHE_NAME = "daw";
const PRECACHE_URLS = [
	"/",
	"/index.html",
	"/manifest.json",
	"/assets/ico.svg",
	"/assets/logo/gs-gs-logo.svg",
	"/assets/logo/gs-gridsound-logo-animated.svg",
	"/assets/gsuiLibrarySamples-v1.js",
	"/assets/gswaPeriodicWavesList-v1.js",
	"/assets/fonts/fa-brands-400.woff2",
	"/assets/fonts/fa-duotone-900.woff2",
	"/assets/fonts/unica-one-400-latin.woff2",
	"/assets/fonts/montserrat-500-latin.woff2",
	"/assets/fonts/montserrat-700-latin.woff2",
	"/assets/fonts/inconsolata-400-latin.woff2",
];

self.addEventListener( "install", e => {
	// Cache each resource independently: a missing one is logged and skipped
	// instead of aborting the whole installation.
	e.waitUntil(
		caches.open( CACHE_NAME )
			.then( cache => Promise.all( PRECACHE_URLS.map( url =>
				cache.add( url ).catch( err => {
					console.warn( `[serviceWorker] precache failed for "${ url }":`, err );
				} )
			) ) )
			.then( () => self.skipWaiting() )
	);
} );

self.addEventListener( "activate", e => {
	e.waitUntil( self.clients.claim() );
} );

self.addEventListener( "fetch", e => {
	// Network first, fall back to the cache, and end with an explicit
	// error response instead of letting the request hang.
	e.respondWith(
		fetch( e.request )
			.catch( () => caches.match( e.request ) )
			.then( res => res || new Response(
				`[serviceWorker] "${ e.request.url }" is unavailable (network failed and no cache entry)`,
				{
					status: 503,
					statusText: "Service Unavailable",
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				}
			) )
	);
} );

self.addEventListener( "message", e => {
	// Let pages ask which precached resources are missing.
	if ( e.data?.type === "precache-status" ) {
		const reply = caches.open( CACHE_NAME )
			.then( cache => Promise.all( PRECACHE_URLS.map( url =>
				cache.match( url ).then( res => res ? null : url )
			) ) )
			.then( entries => entries.filter( Boolean ) )
			.then( missing => {
				e.source?.postMessage( { type: "precache-status", missing } );
			} );

		e.waitUntil?.( reply );
	}
} );
