"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

// .............................................................................

const DAW_STARTUP_SCRIPTS = [
	"assets/gsuiLibrarySamples-v1.js",
	"assets/gsuiWaveletList-v1.js",
];
const DAW_STARTUP_SCRIPT_TIMEOUT = 15; // seconds

// Progress of the startup chain. Each step is marked as done only after
// succeeding, so retrying after a failure resumes from the failed step
// instead of replaying the whole chain.
const dawStartup = {
	running: false, // a chain is currently in flight (extra clicks are ignored)
	started: false, // the whole chain has succeeded
	audioReady: false,
	scriptsSource: null, // null | "network" | "cache", pinned for the whole startup
	scriptsLoaded: new Map( DAW_STARTUP_SCRIPTS.map( url => [ url, false ] ) ),
	daw: null,
};

// --- resource scripts --------------------------------------------------------

// Network-only fetch: the service worker lets these requests fail instead of
// silently serving a cached copy, so every script of the group is guaranteed
// to come from a single source during the whole startup.
function dawStartupFetchScript( url ) {
	return new Promise( ( res, rej ) => {
		const ctrl = new AbortController();
		const tid = setTimeout( () => ctrl.abort(), DAW_STARTUP_SCRIPT_TIMEOUT * 1000 );

		fetch( url, { signal: ctrl.signal, cache: "no-cache" } )
			.then( r => r.ok
				? r.text()
				: Promise.reject( new Error( `HTTP ${ r.status }` ) ) )
			.then( code => res( { url, code } ) )
			.catch( err => rej( new Error( `${ url }: ${ err.name === "AbortError" ? "request timeout" : err.message }` ) ) )
			.finally( () => clearTimeout( tid ) );
	} );
}

function dawStartupFetchScriptFromCache( url ) {
	return caches.match( url ).then( r => r
		? r.text().then( code => ( { url, code } ) )
		: Promise.reject( new Error( `${ url }: not found in the cache` ) ) );
}

function dawStartupExecScript( { url, code } ) {
	const el = document.createElement( "script" );

	el.dataset.url = url;
	el.textContent = code;
	document.head.append( el );
	el.remove();
	dawStartup.scriptsLoaded.set( url, true );
}

function dawStartupLoadScriptsFromCache( urls ) {
	return Promise.all( urls.map( dawStartupFetchScriptFromCache ) ).then( results => {
		dawStartup.scriptsSource = "cache";
		results.forEach( dawStartupExecScript );
	} );
}

function dawStartupLoadScripts() {
	const pending = DAW_STARTUP_SCRIPTS.filter( url => !dawStartup.scriptsLoaded.get( url ) );

	if ( !pending.length ) {
		return Promise.resolve();
	}
	if ( dawStartup.scriptsSource === "cache" ) {
		return dawStartupLoadScriptsFromCache( pending );
	}
	// Each pending script is fetched independently so that a single failure
	// does not discard the others: a retry only reloads the failed ones.
	return Promise.all( pending.map( url => dawStartupFetchScript( url ).then(
		res => res,
		err => ( { url, error: err } ),
	) ) ).then( results => {
		const oks = results.filter( r => !r.error );
		const kos = results.filter( r => r.error );

		if ( oks.length ) {
			dawStartup.scriptsSource = dawStartup.scriptsSource || "network";
			oks.forEach( dawStartupExecScript );
		}
		if ( kos.length ) {
			if ( dawStartup.scriptsSource === "network" ) {
				// The cached copies may be older than the scripts already
				// loaded from the network: both versions must not be mixed,
				// the user has to retry with a working connection.
				throw kos[ 0 ].error;
			}
			return dawStartupLoadScriptsFromCache( kos.map( r => r.url ) );
		}
	} );
}

// --- audio context -----------------------------------------------------------

function dawStartupResumeAudio() {
	return dawStartup.audioReady
		? Promise.resolve()
		: gswaContext.$resume().then( () => {
			dawStartup.audioReady = true;
		} );
}

// --- workbench ---------------------------------------------------------------

function dawStartupInitDAW() {
	if ( dawStartup.daw ) {
		return;
	}
	let daw = null;

	try {
		daw = new GSDAW();
		daw.$init();
		dawStartup.daw = daw;
	} catch ( err ) {
		// Never keep a half-initialized instance around: drop whatever the
		// failed initialization may have left behind before allowing a retry.
		try { daw?.$remove?.(); } catch ( e ) { /* noop */ }
		if ( daw instanceof Node && daw.isConnected ) {
			daw.remove();
		}
		throw err;
	}
}

// --- startup chain -----------------------------------------------------------

function dawStartupRun() {
	return dawStartupResumeAudio()
		.then( dawStartupLoadScripts )
		.then( dawStartupInitDAW );
}

{
	const el = $( "#splashScreen" );
	const elFirefox = el.$query( "[data-alert=firefox]" );
	const elBtn = el.$query( "button" );
	const elSplash = document.querySelector( "#splashScreen" );
	const elErrorMsg = document.querySelector( "#splashScreen [data-error-message]" );

	GSUonFirefox
		? elFirefox.$css( "display", "block" )
		: elFirefox.$remove();

	el.$addAttr( "data-loaded" );
	elBtn.$disabled( false );
	elBtn.$onclick( () => {
		if ( dawStartup.running || dawStartup.started ) {
			return; // ignore extra clicks while a startup chain is in flight
		}
		dawStartup.running = true;
		elBtn.$disabled( true );
		elSplash.removeAttribute( "data-error" );
		el.$addAttr( "data-starting" );
		GSUsetTimeout( () => {
			dawStartupRun().then(
				() => {
					dawStartup.running = false;
					dawStartup.started = true;
					el.$addAttr( "data-started" );
					GSUsetTimeout( () => el.$remove(), .8 );
				},
				err => {
					console.error( "DAW startup failed:", err );
					dawStartup.running = false;
					elSplash.removeAttribute( "data-starting" );
					elErrorMsg.textContent = err.message;
					el.$addAttr( "data-error" );
					elBtn.$disabled( false );
				},
			);
		}, .1 );
	} );
}
