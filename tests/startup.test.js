"use strict";

/*
 * Acceptance checks for the splash-screen startup flow in src/run.js.
 *
 * Dependency-free: a tiny DOM + `$` shim stands in for the browser globals the
 * script uses (respecting the real gs-utils API shapes), and the real
 * src/run.js is evaluated in a fresh context for every scenario.
 *
 * Run with:  node --test tests/startup.test.js
 */

const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const { readFileSync } = require( "node:fs" );
const { join } = require( "node:path" );
const vm = require( "node:vm" );

const REPO = join( __dirname, ".." );
const RUN_SRC = readFileSync( join( REPO, "src/run.js" ), "utf8" );
const SPLASH_HTML = readFileSync( join( REPO, "src/splashScreen.html" ), "utf8" );

// The script's 0.1s paint delay and 0.8s fade are scaled down for the tests.
const CLOCK_SCALE = .1;
const tick = ms => new Promise( resolve => setTimeout( resolve, ms ) );
const LONG = 250; // > the scaled 0.1s startup delay + one load turn

// .............................................................................
// Minimal DOM
class FakeElement {
	constructor( tag ) {
		this.tagName = tag.toUpperCase();
		this.attributes = new Map();
		this.children = [];
		this.parentNode = null;
		this.style = {};
		this.textContent = "";
		this.listeners = new Map();
	}

	setAttribute( name, value ) { this.attributes.set( name, String( value ) ); }
	getAttribute( name ) { return this.attributes.has( name ) ? this.attributes.get( name ) : null; }
	hasAttribute( name ) { return this.attributes.has( name ); }
	removeAttribute( name ) { this.attributes.delete( name ); }

	addEventListener( type, fn ) {
		if ( !this.listeners.has( type ) ) {
			this.listeners.set( type, [] );
		}
		this.listeners.get( type ).push( fn );
	}
	removeEventListener( type, fn ) {
		const arr = this.listeners.get( type );

		if ( arr ) {
			const i = arr.indexOf( fn );

			i > -1 && arr.splice( i, 1 );
		}
	}
	dispatchEvent( ev ) {
		ev.target = this;
		( this.listeners.get( ev.type ) || [] ).slice().forEach( fn => fn( ev ) );
		return true;
	}
	append( child ) {
		child.parentNode = this;
		this.children.push( child );
	}
	remove() {
		const p = this.parentNode;

		if ( p ) {
			const i = p.children.indexOf( this );

			i > -1 && p.children.splice( i, 1 );
			this.parentNode = null;
		}
	}
	descendants() {
		return this.children.flatMap( c => [ c, ...c.descendants() ] );
	}
	// Only the selector shapes src/run.js uses.
	querySelectorAll( sel ) {
		return this.descendants().filter( n => matches( n, sel ) );
	}
}

function matches( node, sel ) {
	if ( sel.startsWith( "#" ) ) {
		return node.getAttribute( "id" ) === sel.slice( 1 );
	}
	const attr = sel.match( /^(\w+)?\[([\w-]+)(?:=([\w-]+))?\]$/ );

	if ( attr ) {
		if ( attr[ 1 ] && node.tagName !== attr[ 1 ].toUpperCase() ) {
			return false;
		}
		return node.hasAttribute( attr[ 2 ] ) &&
			( attr[ 3 ] === undefined || node.getAttribute( attr[ 2 ] ) === attr[ 3 ] );
	}
	return node.tagName === sel.toUpperCase();
}

function queryAll( root, sel ) {
	return root.descendants().filter( n => matches( n, sel ) );
}

// The subset of the gs-utils `$` wrapper used by src/run.js.
class Wrap {
	constructor( elems ) { this.elems = elems; }
	$query( sel ) { return new Wrap( this.elems.flatMap( e => queryAll( e, sel ) ) ); }
	$addAttr( ...names ) {
		this.elems.forEach( e => names.forEach( n => e.setAttribute( n, "" ) ) );
		return this;
	}
	$rmAttr( ...names ) {
		this.elems.forEach( e => names.forEach( n => e.removeAttribute( n ) ) );
		return this;
	}
	$setAttr( name, value ) {
		this.elems.forEach( e => value === false || value == null
			? e.removeAttribute( name )
			: e.setAttribute( name, value === true ? "" : value ) );
		return this;
	}
	$css( prop, value ) {
		this.elems.forEach( e => { e.style[ prop ] = value; } );
		return this;
	}
	$text( value ) {
		this.elems.forEach( e => { e.textContent = value; } );
		return this;
	}
	$disabled( flag ) {
		return this.$setAttr( "disabled", flag );
	}
	$onclick( fn ) {
		this.elems.forEach( e => e.addEventListener( "click", fn ) );
		return this;
	}
	$remove() {
		this.elems.forEach( e => e.remove() );
		return this;
	}
}

// .............................................................................
function makeEnv( { failPlan = {}, initFails = 0, delay = 0, resumeFails = 0, firefox = false } = {} ) {
	const document = {
		head: new FakeElement( "head" ),
		body: new FakeElement( "body" ),
		documentElement: new FakeElement( "html" ),
		listeners: new Map(),
		addEventListener( type, fn ) {
			if ( !this.listeners.has( type ) ) {
				this.listeners.set( type, [] );
			}
			this.listeners.get( type ).push( fn );
		},
		createElement( tag ) {
			return new FakeElement( tag );
		},
	};

	document.documentElement.append( document.head );
	document.documentElement.append( document.body );

	// The splash markup, exactly as src/splashScreen.html declares it.
	const splash = new FakeElement( "div" );

	splash.setAttribute( "id", "splashScreen" );
	const inner = new FakeElement( "div" );
	const version = new FakeElement( "b" );
	const firefoxAlert = new FakeElement( "span" );
	const failure = new FakeElement( "span" );
	const button = new FakeElement( "button" );

	version.textContent = "2.60.2";
	firefoxAlert.setAttribute( "data-alert", "firefox" );
	failure.setAttribute( "data-alert", "failure" );
	button.setAttribute( "disabled", "" );
	inner.append( version );
	inner.append( firefoxAlert );
	inner.append( failure );
	inner.append( button );
	splash.append( inner );
	document.body.append( splash );

	const window = {
		document,
		listeners: new Map(),
		addEventListener( type, fn ) {
			if ( !this.listeners.has( type ) ) {
				this.listeners.set( type, [] );
			}
			this.listeners.get( type ).push( fn );
		},
		removeEventListener( type, fn ) {
			const arr = this.listeners.get( type );

			if ( arr ) {
				const i = arr.indexOf( fn );

				i > -1 && arr.splice( i, 1 );
			}
		},
		dispatchEvent( ev ) {
			( this.listeners.get( ev.type ) || [] ).slice().forEach( fn => fn( ev ) );
			return true;
		},
	};

	const calls = {
		resume: 0,
		loads: {},
		dawBuilt: 0,
		dawInitOk: 0,
		initFailLeft: initFails,
		resumeFailLeft: resumeFails,
	};
	const failuresLeft = new Map( Object.entries( failPlan ) );

	const api = {
		$: sel => new Wrap( queryAll( document.documentElement, sel ) ),
		document,
		window,
		console,
		GSUonFirefox: firefox,
		GSUsetTimeout: ( fn, sec ) => setTimeout( fn, Math.max( 0, sec * 1000 * CLOCK_SCALE ) ),
		gswaContext: {
			$resume() {
				calls.resume++;
				if ( calls.resumeFailLeft > 0 ) {
					calls.resumeFailLeft--;
					return Promise.reject( new Error( "resume boom" ) );
				}
				return delay ? new Promise( r => setTimeout( r, delay ) ) : Promise.resolve();
			},
		},
		GSUloadJSFile( src ) {
			const name = src.includes( "Samples" ) ? "samples" : "wavelets";

			calls.loads[ name ] = ( calls.loads[ name ] || 0 ) + 1;
			// Same as the real helper: append a <script>, resolve on "load".
			const node = document.createElement( "script" );

			node.src = src;
			document.head.append( node );
			const left = failuresLeft.get( name ) || 0;

			if ( left > 0 ) {
				// A broken resource fires "error" on the script, which the
				// browser (and the run.js wrapper, capture phase) sees on window.
				failuresLeft.set( name, left - 1 );
				setTimeout( () => window.dispatchEvent( { type: "error", target: node } ), 0 );
				return new Promise( () => {} );
			}
			setTimeout( () => node.dispatchEvent( { type: "load" } ), delay );
			return new Promise( resolve => node.addEventListener( "load", resolve ) );
		},
		GSDAW: class GSDAW {
			constructor() { calls.dawBuilt++; }
			$init() {
				if ( calls.initFailLeft > 0 ) {
					calls.initFailLeft--;
					return Promise.reject( new Error( "daw init boom" ) );
				}
				calls.dawInitOk++;
				return Promise.resolve();
			}
		},
	};

	const context = vm.createContext( api );

	vm.runInContext( RUN_SRC, context, { filename: "run.js" } );
	return { document, calls, window };
}

const ui = document => {
	const splash = queryAll( document.documentElement, "#splashScreen" )[ 0 ];
	const button = queryAll( splash, "button" )[ 0 ];
	const failure = queryAll( document.documentElement, "[data-alert=failure]" )[ 0 ];

	return {
		splash,
		button,
		failure,
		phase() { return splash.getAttribute( "data-start-phase" ); },
		failedAt() { return splash.getAttribute( "data-start-failed-at" ); },
		has: n => splash.hasAttribute( n ),
		click() { button.dispatchEvent( { type: "click" } ); },
	};
};

// .............................................................................
test( "normal startup performs each step once and creates the DAW once", async () => {
	const { document, calls } = makeEnv();
	const u = ui( document );

	assert.equal( u.button.hasAttribute( "disabled" ), false, "the button is clickable" );
	assert.equal( u.phase(), null );
	u.click();
	await tick( LONG );
	assert.equal( calls.resume, 1 );
	assert.equal( calls.loads.samples, 1 );
	assert.equal( calls.loads.wavelets, 1 );
	assert.equal( calls.dawBuilt, 1 );
	assert.equal( calls.dawInitOk, 1 );
	assert.equal( u.has( "data-started" ), true );

	u.click();
	u.click();
	await tick( 30 );
	assert.equal( calls.resume, 1, "extra clicks after start are ignored" );
	assert.equal( calls.dawBuilt, 1 );
} );

test( "a failed resource shows a retryable failure state and the retry completes the startup", async () => {
	const { document, calls } = makeEnv( { failPlan: { samples: 1 } } );
	const u = ui( document );

	u.click();
	await tick( LONG );
	assert.equal( u.phase(), "failed" );
	assert.equal( u.failedAt(), "samples" );
	assert.equal( u.has( "data-start-failed" ), true );
	assert.equal( u.has( "data-starting" ), false, "the stuck 'starting...' state is cleared" );
	assert.equal( u.button.hasAttribute( "disabled" ), false, "the button is clickable again" );
	assert.match( u.failure.textContent, /samples/ );
	assert.equal( calls.dawBuilt, 0 );

	u.click();
	await tick( LONG );
	assert.equal( u.has( "data-started" ), true );
	assert.equal( calls.resume, 1, "the audio context is not resumed twice" );
	assert.equal( calls.loads.samples, 2, "only the failed load is re-run" );
	assert.equal( calls.loads.wavelets, 1, "already loaded resources are not reloaded" );
	assert.equal( calls.dawBuilt, 1 );
	assert.equal( calls.dawInitOk, 1 );
	assert.equal( u.has( "data-start-failed" ), false );
} );

test( "repeated clicks never stack startup tasks", async () => {
	const { document, calls } = makeEnv( { delay: 40 } );
	const u = ui( document );

	for ( let i = 0; i < 10; i++ ) {
		u.click();
	}
	await tick( LONG + 150 );
	assert.equal( calls.resume, 1 );
	assert.equal( calls.loads.samples, 1 );
	assert.equal( calls.loads.wavelets, 1 );
	assert.equal( calls.dawBuilt, 1 );
	assert.equal( calls.dawInitOk, 1 );
	assert.equal( u.has( "data-started" ), true );
} );

test( "interleaved failures and retries still create the DAW exactly once", async () => {
	const { document, calls } = makeEnv( { failPlan: { samples: 2 }, delay: 20 } );
	const u = ui( document );

	u.click();
	await tick( LONG + 100 );
	assert.equal( u.phase(), "failed" );
	for ( let i = 0; i < 6; i++ ) {
		u.click();
	}
	await tick( LONG + 100 );
	assert.equal( u.phase(), "failed" );
	assert.equal( calls.loads.samples, 2, "clicks during a retry do not stack loads" );
	assert.equal( calls.resume, 1 );

	u.click();
	u.click();
	await tick( LONG + 250 );
	assert.equal( u.has( "data-started" ), true );
	assert.equal( calls.loads.samples, 3 );
	assert.equal( calls.resume, 1 );
	assert.equal( calls.loads.wavelets, 1 );
	assert.equal( calls.dawBuilt, 1 );
	assert.equal( calls.dawInitOk, 1 );
} );

test( "a failed DAW init leaves no duplicate interface behind", async () => {
	const { document, calls } = makeEnv( { initFails: 1 } );
	const u = ui( document );

	u.click();
	await tick( LONG );
	assert.equal( u.phase(), "failed" );
	assert.equal( u.failedAt(), "daw" );
	assert.equal( calls.loads.samples, 1, "assets are not reloaded for a DAW failure" );

	u.click();
	await tick( LONG );
	assert.equal( u.has( "data-started" ), true );
	assert.equal( calls.dawBuilt, 2, "the half-initialized instance is discarded" );
	assert.equal( calls.dawInitOk, 1, "a DAW is initialized successfully only once" );
	assert.equal( calls.resume, 1 );
} );

test( "an audio-context resume failure is retryable", async () => {
	const { document, calls } = makeEnv( { resumeFails: 1 } );
	const u = ui( document );

	u.click();
	await tick( LONG );
	assert.equal( u.phase(), "failed" );
	assert.equal( u.failedAt(), "resume" );
	assert.equal( u.has( "data-starting" ), false );
	assert.equal( u.button.hasAttribute( "disabled" ), false );

	u.click();
	await tick( LONG );
	assert.equal( u.has( "data-started" ), true );
	assert.equal( calls.resume, 2 );
	assert.equal( calls.loads.samples, 1 );
	assert.equal( calls.loads.wavelets, 1 );
	assert.equal( calls.dawBuilt, 1 );
} );

test( "the splash page keeps its version display and Firefox alert", () => {
	const { document } = makeEnv();
	const splash = queryAll( document.documentElement, "#splashScreen" )[ 0 ];

	assert.match( SPLASH_HTML, /\{\{GSDAW-VERSION\}\}/, "the version placeholder is preserved" );
	assert.match( SPLASH_HTML, /data-alert="firefox"/, "the Firefox alert is preserved" );
	assert.equal( queryAll( splash, "b" ).length, 1, "the version node is kept" );
	assert.equal( splash.children[ 0 ].children.some( n => n.tagName === "B" ), true );
} );

test( "on Firefox the alert is shown instead of being removed", async () => {
	const { document, calls } = makeEnv( { firefox: true } );
	const u = ui( document );
	const firefox = queryAll( document.documentElement, "[data-alert=firefox]" )[ 0 ];

	assert.notEqual( firefox, undefined, "the Firefox alert is preserved on Firefox" );
	assert.equal( firefox.style.display, "block" );
	u.click();
	await tick( LONG );
	assert.equal( calls.dawBuilt, 1 );
} );
