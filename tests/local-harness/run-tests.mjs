// End-to-end verification of the startup state machine and the service worker.
// Spawns server.mjs itself, drives a real Chromium via Playwright, and exits
// non-zero if any scenario fails.
//
// Scenarios:
//   1. sample-library script fails once, retry resumes at the failed phase
//   2. rapid repeated clicks run exactly one startup chain
//   3. offline refresh: precached resources make the whole chain work offline
//   4. version bump: new versioned cache is created, the old one is deleted
//   5. a precache failure leaves no half-filled cache; a later retry installs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname( fileURLToPath( import.meta.url ) );
const runtime = join( here, "runtime" );
const port = 8123;
const base = `http://localhost:${ port }`;
const VERSION_A = "2.60.2";
const VERSION_B = "2.61.0-testB";
const VERSION_C = "2.62.0-testC";

let failures = 0;
const ok = ( cond, msg ) => {
	if ( cond ) {
		console.log( `    ✓ ${ msg }` );
	} else {
		++failures;
		console.error( `    ✗ ${ msg }` );
	}
};
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
const waitFor = async ( label, fn, timeout = 8000 ) => {
	const t0 = Date.now();
	let last;
	while ( Date.now() - t0 < timeout ) {
		try {
			last = await fn();
			if ( last ) { return last; }
		} catch ( err ) { last = err; }
		await sleep( 50 );
	}
	throw new Error( `timeout waiting for ${ label } (last: ${ last })` );
};
const build = version => new Promise( ( resolve, reject ) => {
	const p = spawn( process.execPath, [ join( here, "build-site.mjs" ), version ], { stdio: "inherit" } );
	p.on( "exit", code => code ? reject( new Error( `build failed (${ code })` ) ) : resolve() );
} );
const control = ( path, body ) => fetch( `${ base }${ path }`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: body && JSON.stringify( body ),
} ).then( r => r.text() );
const snapshot = page => page.evaluate( () => ( {
	state: document.getElementById( "splashScreen" )?.dataset.state ?? "removed",
	phase: document.getElementById( "splashScreen" )?.dataset.phase ?? null,
	errPhase: document.querySelector( "[data-error-phase]" )?.textContent ?? null,
	errMsg: document.querySelector( "[data-error-msg]" )?.textContent ?? null,
	errorVisible: !document.querySelector( "[data-error]" )?.hidden,
	buttonDisabled: document.querySelector( "#splashScreen > div > button" )?.disabled ?? null,
	gs: window.__gs,
} ) );
const cacheDump = page => page.evaluate( async () => {
	const keys = await caches.keys();
	const dump = {};
	for ( const key of keys ) {
		const c = await caches.open( key );
		dump[ key ] = ( await c.keys() ).map( r => new URL( r.url ).pathname );
	}
	return dump;
} );
// Robust activation boundary: keep nudging registration.update() (which
// bypasses the browser update throttle) until the new cache exists and the
// old one has been deleted by the activate handler.
const waitForCacheSwap = async ( newV, oldV ) => {
	const t0 = Date.now();
	while ( Date.now() - t0 < 20000 ) {
		await page.evaluate( () => navigator.serviceWorker.getRegistration()
			.then( reg => reg && reg.update() ) );
		const d = await cacheDump( page );
		if ( d[ `daw-${ newV }` ] && !d[ `daw-${ oldV }` ] ) {
			return;
		}
		await sleep( 500 );
	}
	throw new Error( `timeout waiting for cache swap to daw-${ newV }` );
};

console.log( "building mock site and starting server" );
rmSync( runtime, { recursive: true, force: true } );
await build( VERSION_A );
const server = spawn( process.execPath, [ join( here, "server.mjs" ) ], {
	cwd: here,
	stdio: "inherit",
	env: { ...process.env, PORT: String( port ) },
} );
await waitFor( "http server", async () => {
	try { return ( await fetch( base ) ).ok; } catch { return false; }
} );

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on( "console", m => { if ( m.type() === "error" ) console.log( `    [console.error] ${ m.text() }` ); } );
page.on( "pageerror", e => console.log( `    [pageerror] ${ e.message }` ) );

try {
	// ---------- Scenario 1: failure then retry from the failed phase ----------
	console.log( "\n[1] sample library fails once, then retry succeeds" );
	await control( "/__control/fail", { gsuiLibrarySamples: "simulated HTTP 500" } );
	await page.goto( `${ base }?nosw=1` );
	await waitFor( "splash ready", () => page.locator( "#splashScreen[data-loaded]" ).count() );
	ok( await page.evaluate( () => getComputedStyle( document.querySelector( "[data-error]" ) ).display ) === "none",
		"error panel is hidden before any failure" );
	// Browsers do not expose the HTTP status to a <script> onerror handler;
	// annotate the expected failure client-side (like an app-level loader would).
	await page.evaluate( () => { window.__gs.fail[ "gsuiLibrarySamples" ] = "simulated HTTP 500"; } );
	await page.locator( "#splashScreen > div > button" ).click();
	await waitFor( "error state", async () => ( await snapshot( page ) ).state === "error" );
	let s = await snapshot( page );
	ok( s.state === "error", "entered the error state" );
	ok( s.phase === "samples", `failed phase is "samples" (got "${ s.phase }")` );
	ok( !!s.errMsg && s.errMsg.includes( "simulated HTTP 500" ), `error message is shown (got "${ s.errMsg }")` );
	ok( s.errorVisible, "error panel is visible with a Retry button" );
	ok( await page.evaluate( () => getComputedStyle( document.querySelector( "[data-error]" ) ).display ) !== "none",
		"error panel is actually rendered (display != none)" );
	ok( s.buttonDisabled === false, "start button is enabled again after failure" );
	ok( s.gs.resumeCalls === 1, `audio resume ran once before the failure (got ${ s.gs.resumeCalls })` );
	ok( !s.gs.loaded.some( u => u.includes( "gsuiLibrarySamples" ) ), "sample library was not executed" );
	ok( s.gs.events.some( e => e.type === "splash:error" && e.detail.phase === "samples" ), "splash:error event dispatched for samples" );

	// The server failure was one-shot: the retry request goes through normally.
	await page.locator( "[data-retry]" ).click();
	await waitFor( "done state", async () => ( await snapshot( page ) ).state === "done" );
	s = await snapshot( page );
	ok( !s.errorVisible, "error panel is hidden again after the successful retry" );
	ok( s.gs.resumeCalls === 1, `retry did NOT re-run the resume phase (resumeCalls still ${ s.gs.resumeCalls })` );
	ok( s.gs.loaded.filter( u => u.includes( "gsuiLibrarySamples" ) ).length === 1, "sample library loaded exactly once" );
	ok( s.gs.loaded.some( u => u.includes( "gsuiWaveletList" ) ), "wavetable script loaded after the retried phase" );
	ok( s.gs.dawConstructed === 1 && s.gs.dawInitCalls === 1, "GSDAW constructed and initialized once" );
	await waitFor( "splash removal", async () => ( await snapshot( page ) ).state === "removed" );
	const retryPhases = s.gs.events.filter( e => e.type === "splash:phase" ).map( e => e.detail.phase );
	ok( JSON.stringify( retryPhases ) === JSON.stringify( [ "resume", "samples", "samples", "wavetable", "init" ] ),
		`phase events resumed at "samples" without replaying "resume" (got ${ JSON.stringify( retryPhases ) })` );

	// ---------- Scenario 2: rapid repeated clicks -----------------------------
	console.log( "\n[2] five rapid clicks run a single chain" );
	await page.goto( `${ base }?nosw=1` );
	await waitFor( "splash ready", () => page.locator( "#splashScreen[data-loaded]" ).count() );
	await page.evaluate( () => {
		const btn = document.querySelector( "#splashScreen > div > button" );
		for ( let i = 0; i < 5; ++i ) { btn.click(); }
	} );
	await waitFor( "done state", async () => ( await snapshot( page ) ).state === "done" );
	s = await snapshot( page );
	ok( s.gs.resumeCalls === 1, `audio resume ran once (got ${ s.gs.resumeCalls })` );
	ok( s.gs.dawConstructed === 1 && s.gs.dawInitCalls === 1, "GSDAW constructed and initialized once" );
	ok( s.gs.loaded.length === 2, `only the two startup scripts loaded (got ${ s.gs.loaded.length })` );
	const uniqPhases = new Set( s.gs.events.filter( e => e.type === "splash:phase" ).map( e => e.detail.phase ) );
	ok( uniqPhases.size === 4, `each of the 4 phases fired once (got ${ [ ...uniqPhases ].join( "," ) })` );
	await waitFor( "splash removal", async () => ( await snapshot( page ) ).state === "removed" );

	// ---------- Scenario 3: offline refresh ------------------------------------
	console.log( "\n[3] offline refresh serves the whole chain from the cache" );
	await page.goto( base );
	await waitFor( "service worker controlling", () => page.evaluate( () => !!navigator.serviceWorker.controller ) );
	const cacheName = `daw-${ VERSION_A }`;
	await waitFor( "precache filled", async () => ( await cacheDump( page ) )[ cacheName ]?.length >= 15 );
	let dump = await cacheDump( page );
	ok( !!dump[ cacheName ], `versioned cache "${ cacheName }" exists` );
	for ( const u of [ "/index.html", "/assets/gsuiLibrarySamples-v1.js", "/assets/gsuiWaveletList-v1.js", "/manifest.json" ] ) {
		ok( dump[ cacheName ].includes( u ), `precache contains ${ u }` );
	}

	await context.setOffline( true );
	try {
		await page.reload( { waitUntil: "domcontentloaded" } );
		await waitFor( "offline splash ready", () => page.locator( "#splashScreen[data-loaded]" ).count() );
		ok( await page.evaluate( () => !!navigator.serviceWorker.controller ), "offline page is still controlled by the service worker" );
		await page.locator( "#splashScreen > div > button" ).click();
		await waitFor( "done state offline", async () => ( await snapshot( page ) ).state === "done" );
		s = await snapshot( page );
		ok( s.gs.loaded.some( u => u.includes( "gsuiLibrarySamples" ) ) && s.gs.loaded.some( u => u.includes( "gsuiWaveletList" ) ),
			"both startup scripts executed while offline (served from cache)" );
		ok( s.gs.dawInitCalls === 1, "GSDAW initialized offline" );
	} finally {
		await context.setOffline( false );
	}

	// ---------- Scenario 4: version bump cleans the old cache ------------------
	console.log( "\n[4] version bump replaces the cache and deletes the old one" );
	await build( VERSION_B );
	await page.reload( { waitUntil: "domcontentloaded" } );
	await waitForCacheSwap( VERSION_B, VERSION_A );
	dump = await cacheDump( page );
	ok( !!dump[ `daw-${ VERSION_B }` ], `new versioned cache "daw-${ VERSION_B }" was created` );
	ok( !dump[ `daw-${ VERSION_A }` ], `old cache "daw-${ VERSION_A }" was deleted on activate` );
	ok( Object.keys( dump ).every( k => k === `daw-${ VERSION_B }` ), "no stale daw-* cache remains" );

	// ---------- Scenario 5: failed precache is atomic --------------------------
	console.log( "\n[5] a precache failure leaves no half-filled cache" );
	await build( VERSION_C );
	const fontPath = join( runtime, "assets/fonts/inconsolata-400-latin.woff2" );
	const tmpPath = `${ fontPath }.held`;
	renameSync( fontPath, tmpPath ); // make one precache URL 404
	try {
		await page.reload( { waitUntil: "domcontentloaded" } );
		await sleep( 1500 ); // give the failing install time to settle
		dump = await cacheDump( page );
		ok( !dump[ `daw-${ VERSION_C }` ], `no "daw-${ VERSION_C }" cache exists after the failed install` );
		ok( !Object.keys( dump ).some( k => k.includes( VERSION_C ) ), "no half-filled cache for the new version was left behind" );
	} finally {
		renameSync( tmpPath, fontPath );
	}
	await page.reload( { waitUntil: "domcontentloaded" } );
	await waitForCacheSwap( VERSION_C, VERSION_B );
	dump = await cacheDump( page );
	ok( !!dump[ `daw-${ VERSION_C }` ], "after restoring the resource, the next install succeeds" );
	ok( !dump[ `daw-${ VERSION_B }` ], "activation also removed the previous version's cache" );
	ok( dump[ `daw-${ VERSION_C }` ].length >= 15, "the new cache contains the full precache list" );
} catch ( err ) {
	++failures;
	console.error( "\nFATAL:", err );
} finally {
	await context.close().catch( () => {} );
	await browser.close().catch( () => {} );
	server.kill();
}

console.log( failures ? `\nFAILED (${ failures } assertion${ failures > 1 ? "s" : "" })` : "\nALL SCENARIOS PASSED" );
process.exit( failures ? 1 : 0 );
