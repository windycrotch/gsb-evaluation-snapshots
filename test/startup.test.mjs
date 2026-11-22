// Acceptance tests for the splash-screen startup chain (src/run.js).
// Run with: node test/startup.test.mjs
//
// The browser/GSU globals used by run.js are mocked with a minimal DOM so
// every startup scenario can be driven synchronously from Node.
"use strict";

import { readFileSync } from "node:fs";

const RUN_JS = new URL( "../src/run.js", import.meta.url );
const wait = ms => new Promise( res => setTimeout( res, ms ) );

// --- minimal DOM --------------------------------------------------------------

class El {
	constructor( tag ) {
		this.tagName = tag;
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.parent = null;
		this.textContent = "";
		this.dataset = {};
		this.disabled = false;
	}
	setAttribute( k, v = "" ) { this.attributes[ k ] = String( v ); }
	removeAttribute( k ) { delete this.attributes[ k ]; }
	getAttribute( k ) { return this.attributes[ k ]; }
	append( c ) { c.parent = this; this.children.push( c ); }
	remove() {
		if ( this.parent ) {
			const i = this.parent.children.indexOf( this );

			if ( i >= 0 ) { this.parent.children.splice( i, 1 ); }
			this.parent = null;
		}
	}
	get isConnected() {
		let n = this;

		while ( n.parent ) { n = n.parent; }
		return n === this.__root;
	}
	addEventListener( t, f ) { ( this.listeners[ t ] ??= [] ).push( f ); }
	click() {
		if ( this.disabled ) { return; }
		( this.listeners.click || [] ).forEach( f => f() );
	}
	querySelector( sel ) { return queryAll( this, sel )[ 0 ] || null; }
}

function matchSimple( el, s ) {
	if ( s.startsWith( "#" ) ) { return el.attributes.id === s.slice( 1 ); }
	if ( s.startsWith( "[" ) ) {
		const m = /^\[([\w-]+)(?:=([^\]]+))?\]$/.exec( s );

		return m[ 2 ] === undefined
			? m[ 1 ] in el.attributes
			: el.attributes[ m[ 1 ] ] === m[ 2 ];
	}
	return el.tagName === s;
}

function queryAll( root, sel ) {
	let current = [ root ];

	for ( const part of sel.trim().split( /\s+/ ) ) {
		const next = [];

		for ( const node of current ) {
			( function walk( el ) {
				el.children.forEach( c => {
					if ( matchSimple( c, part ) ) { next.push( c ); }
					walk( c );
				} );
			} )( node );
		}
		current = next;
	}
	return current;
}

// --- test environment -----------------------------------------------------------

function makeEnv() {
	const root = new El( "html" );
	const head = new El( "head" );
	const body = new El( "body" );
	const splash = new El( "div" );
	const inner = new El( "div" );
	const firefox = new El( "span" );
	const errAlert = new El( "span" );
	const errMsg = new El( "b" );
	const btn = new El( "button" );

	root.append( head );
	root.append( body );
	splash.setAttribute( "id", "splashScreen" );
	firefox.setAttribute( "data-alert", "firefox" );
	errAlert.setAttribute( "data-alert", "error" );
	errMsg.setAttribute( "data-error-message", "" );
	btn.disabled = true;
	errAlert.append( errMsg );
	inner.append( firefox );
	inner.append( errAlert );
	inner.append( btn );
	splash.append( inner );
	body.append( splash );
	[ root, head, body, splash, inner ].forEach( el => {
		Object.defineProperty( el, "__root", { value: root, configurable: true } );
	} );
	// isConnected walks up to the root element
	El.prototype.__root = root;

	const env = {
		root, head, body, splash, btn, errMsg,
		executedScripts: [], // { url, code }
		fetchCalls: [],
		resumeCalls: 0,
		dawInstances: [],
		resumeBehavior: () => Promise.resolve(),
		fetchBehavior: () => ( { ok: true, status: 200 } ),
		initBehavior: () => {},
		cacheStore: new Map(), // pathname -> code
	};

	const wrap = el => !el ? null : {
		$query: s => wrap( el.querySelector( s ) ),
		$css: () => wrap( el ),
		$remove: () => el.remove(),
		$addAttr: n => ( el.setAttribute( n, "" ), wrap( el ) ),
		$onclick: fn => ( el.addEventListener( "click", fn ), wrap( el ) ),
		$disabled: b => ( el.disabled = b, wrap( el ) ),
	};
	const documentMock = {
		head,
		body,
		addEventListener: () => {},
		createElement: tag => new El( tag ),
		querySelector: sel => queryAll( root, sel )[ 0 ] || null,
	};
	const headAppend = head.append.bind( head );

	head.append = el => {
		if ( el.tagName === "script" ) {
			env.executedScripts.push( { url: el.dataset.url, code: el.textContent } );
		}
		headAppend( el );
	};

	class GSDAWMock extends El {
		constructor() {
			super( "gs-daw" );
			env.dawInstances.push( this );
		}
		$init() {
			env.initBehavior( this );
			body.append( this ); // a successful init mounts the workbench
		}
		$remove() { this.remove(); }
	}

	const globals = {
		document: documentMock,
		window: {},
		$: sel => wrap( documentMock.querySelector( sel ) ),
		GSUonFirefox: false,
		GSUsetTimeout: ( fn, s ) => setTimeout( fn, s * 1000 ),
		gswaContext: {
			$resume: () => {
				env.resumeCalls++;
				return env.resumeBehavior();
			},
		},
		GSDAW: GSDAWMock,
		fetch: async ( url, opts ) => {
			env.fetchCalls.push( url );
			const r = env.fetchBehavior( url );

			if ( r instanceof Error ) { throw r; }
			return { ok: r.ok, status: r.status, text: async () => `// net ${ url }` };
		},
		caches: {
			match: async url => {
				const path = new URL( url, "https://daw.test/" ).pathname;

				return env.cacheStore.has( path )
					? { text: async () => env.cacheStore.get( path ) }
					: undefined;
			},
		},
		Node: El,
		AbortController,
		console,
		setTimeout,
		clearTimeout,
	};

	const src = readFileSync( RUN_JS, "utf8" );
	const names = Object.keys( globals );

	new Function( ...names, src )( ...names.map( n => globals[ n ] ) );
	return env;
}

// --- assertions -------------------------------------------------------------------

let failures = 0;

function assert( cond, msg ) {
	if ( cond ) {
		console.log( `  ok - ${ msg }` );
	} else {
		failures++;
		console.error( `  FAIL - ${ msg }` );
	}
}

const SAMPLES = "assets/gsuiLibrarySamples-v1.js";
const WAVELET = "assets/gsuiWaveletList-v1.js";
const countFetch = ( env, url ) => env.fetchCalls.filter( u => u === url ).length;

// --- scenarios --------------------------------------------------------------------

async function testNormalStartup() {
	console.log( "normal startup succeeds in one go" );
	const env = makeEnv();

	env.btn.click();
	await wait( 300 );
	assert( env.resumeCalls === 1, "audio context resumed once" );
	assert( env.executedScripts.length === 2, "both resource scripts executed" );
	assert( env.dawInstances.length === 1, "one DAW instance created" );
	assert( "data-started" in env.splash.attributes, "splash marked as started" );
	await wait( 900 );
	assert( env.splash.parent === null, "splash screen removed after success" );
}

async function testAudioRejectedThenRetry() {
	console.log( "audio resume rejected, then retry succeeds" );
	const env = makeEnv();
	let fail = true;

	env.resumeBehavior = () => fail
		? Promise.reject( new Error( "NotAllowedError" ) )
		: Promise.resolve();
	env.btn.click();
	await wait( 300 );
	assert( "data-error" in env.splash.attributes, "error state is visible" );
	assert( !( "data-starting" in env.splash.attributes ), "no longer in starting state" );
	assert( env.btn.disabled === false, "button re-enabled for retry" );
	assert( env.errMsg.textContent.includes( "NotAllowedError" ), "error message displayed" );
	assert( env.fetchCalls.length === 0, "resource scripts not loaded yet" );

	fail = false;
	env.btn.click();
	await wait( 300 );
	assert( env.resumeCalls === 2, "resume retried" );
	assert( "data-started" in env.splash.attributes, "startup completes after retry" );
}

async function testScript404ThenRetry() {
	console.log( "script 404, retry reloads only the failed script" );
	const env = makeEnv();
	let wavelet404 = true;

	env.fetchBehavior = url => url === WAVELET && wavelet404
		? { ok: false, status: 404 }
		: { ok: true, status: 200 };
	env.btn.click();
	await wait( 300 );
	assert( "data-error" in env.splash.attributes, "error state is visible" );
	assert( env.executedScripts.some( s => s.url === SAMPLES ), "samples script kept from network" );
	assert( !env.executedScripts.some( s => s.url === WAVELET ), "wavelet script not executed" );

	wavelet404 = false;
	env.btn.click();
	await wait( 300 );
	assert( "data-started" in env.splash.attributes, "startup completes after retry" );
	assert( countFetch( env, SAMPLES ) === 1, "samples script NOT reloaded" );
	assert( countFetch( env, WAVELET ) === 2, "only the failed script reloaded" );
	assert( env.resumeCalls === 1, "audio step not replayed" );
}

async function testInitThrows() {
	console.log( "workbench init throws: no half-initialized instance remains" );
	const env = makeEnv();
	let fail = true;

	env.initBehavior = daw => {
		if ( fail ) {
			env.body.append( daw ); // half-initialized instance leaks into the DOM
			throw new Error( "init boom" );
		}
	};
	env.btn.click();
	await wait( 300 );
	assert( "data-error" in env.splash.attributes, "error state is visible" );
	assert( env.dawInstances.length === 1, "one instance was created" );
	assert( !env.dawInstances[ 0 ].isConnected, "half-initialized instance removed from the page" );

	fail = false;
	env.btn.click();
	await wait( 300 );
	assert( env.dawInstances.length === 2, "retry builds a fresh instance" );
	assert( env.dawInstances[ 1 ].isConnected, "new instance mounted" );
	assert( countFetch( env, SAMPLES ) === 1, "scripts not reloaded on init retry" );
	assert( "data-started" in env.splash.attributes, "startup completes after retry" );
}

async function testOfflineCacheConsistency() {
	console.log( "offline: cache and network results are never mixed" );
	{
		// Fully offline: the whole group falls back to the cache.
		const env = makeEnv();

		env.fetchBehavior = () => new Error( "network down" );
		env.cacheStore.set( `/${ SAMPLES }`, `// cache ${ SAMPLES }` );
		env.cacheStore.set( `/${ WAVELET }`, `// cache ${ WAVELET }` );
		env.btn.click();
		await wait( 300 );
		assert( "data-started" in env.splash.attributes, "startup succeeds from cache" );
		assert( env.executedScripts.every( s => s.code.startsWith( "// cache" ) ),
			"all scripts come from the cache" );
	}
	{
		// One script from network, the other only in cache: must NOT mix.
		const env = makeEnv();

		env.fetchBehavior = url => url === WAVELET
			? new Error( "network down" )
			: { ok: true, status: 200 };
		env.cacheStore.set( `/${ WAVELET }`, `// cache ${ WAVELET }` );
		env.btn.click();
		await wait( 300 );
		assert( "data-error" in env.splash.attributes, "mixed versions refused, error shown" );
		assert( !env.executedScripts.some( s => s.code.startsWith( "// cache" ) ),
			"stale cached script not combined with the network one" );

		env.fetchBehavior = () => ( { ok: true, status: 200 } ); // connection back
		env.btn.click();
		await wait( 300 );
		assert( "data-started" in env.splash.attributes, "retry succeeds over the network" );
		assert( env.executedScripts.every( s => s.code.startsWith( "// net" ) ),
			"all scripts come from the network" );
	}
}

async function testRapidClicks() {
	console.log( "rapid clicks trigger a single startup chain" );
	const env = makeEnv();

	env.btn.click();
	env.btn.click();
	env.btn.click();
	await wait( 300 );
	assert( env.resumeCalls === 1, "audio resumed exactly once" );
	assert( countFetch( env, SAMPLES ) === 1, "samples fetched exactly once" );
	assert( countFetch( env, WAVELET ) === 1, "wavelet list fetched exactly once" );
	assert( env.dawInstances.length === 1, "exactly one DAW instance" );
	assert( "data-started" in env.splash.attributes, "startup succeeded" );
}

// --- run ------------------------------------------------------------------------------

await testNormalStartup();
await testAudioRejectedThenRetry();
await testScript404ThenRetry();
await testInitThrows();
await testOfflineCacheConsistency();
await testRapidClicks();

console.log( failures ? `\n${ failures } assertion(s) FAILED` : "\nall tests passed" );
process.exit( failures ? 1 : 0 );
