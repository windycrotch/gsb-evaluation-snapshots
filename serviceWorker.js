"use strict";

// {{GSDAW-VERSION}} is replaced by the version of build-conf.json at build time.
const VERSION = "{{GSDAW-VERSION}}";
const CACHE_NAME = `daw-${ VERSION }`;
const PRECACHE_URLS = [
	"/",
	"/index.html",
	"/manifest.json",
	"/assets/ico.svg",
	"/assets/logo/gs-gs-logo.svg",
	"/assets/logo/gs-gridsound-logo-animated.svg",
	// Startup chain dependencies (see src/run.js).
	"/assets/gsuiLibrarySamples-v1.js",
	"/assets/gsuiWaveletList-v1.js",
	"/assets/fonts/fa-brands-400.woff2",
	"/assets/fonts/fa-duotone-900.woff2",
	"/assets/fonts/unica-one-400-latin.woff2",
	"/assets/fonts/montserrat-500-latin.woff2",
	"/assets/fonts/montserrat-700-latin.woff2",
	"/assets/fonts/inconsolata-400-latin.woff2",
];

self.addEventListener( "install", e => {
	e.waitUntil(
		caches.open( CACHE_NAME )
			// cache.addAll rejects on the first failure (e.g. a 404); the cache
			// is then deleted so a failed install never leaves a half-filled
			// cache behind and the next install starts from scratch.
			.then( cache => cache.addAll( PRECACHE_URLS )
				.catch( err => caches.delete( CACHE_NAME ).then( () => Promise.reject( err ) ) ) )
			// Take control immediately so a new version does not wait for a
			// second navigation.
			.then( () => self.skipWaiting() )
	);
} );

self.addEventListener( "activate", e => {
	e.waitUntil(
		caches.keys()
			.then( keys => Promise.all( keys
				.filter( key => key !== CACHE_NAME )
				.map( key => caches.delete( key ) ) ) )
			.then( () => self.clients.claim() )
	);
} );

self.addEventListener( "fetch", e => {
	const { request } = e;

	if ( request.method !== "GET" ) {
		return;
	}
	e.respondWith(
		fetch( request ).catch( () =>
			caches.match( request ).then( res =>
				res || ( request.mode === "navigate"
					? caches.match( "/index.html" )
					: Promise.reject( new Error( `offline and no cache for ${ request.url }` ) ) ) ) )
	);
} );
