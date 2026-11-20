"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

/*
 * Splash screen startup flow:
 *   1. the user clicks the button
 *   2. the audio context is resumed
 *   3. the samples library is loaded
 *   4. the wavetables list is loaded
 *   5. the DAW (main interface) is created
 *
 * On failure the button switches to an explicit failed state and the user can
 * click again to retry. Both guarantees below are enforced here, not in CSS:
 *
 *   - Only one startup chain can run at a time (`attempt`): extra clicks are
 *     ignored while an attempt is in flight and the button is disabled, so no
 *     loading task is ever stacked.
 *   - Every step is memoized (`memoizedStep`): while pending, all the callers
 *     share the very same promise; once fulfilled, the step is never executed
 *     again. Only a rejected step is dropped from the memo, so a retry resumes
 *     from the failed step. The audio context resume and the DAW creation
 *     therefore succeed at most one time, even if attempts interleave.
 */

const STARTUP_STEP = {
	RESUME: "resume",
	SAMPLES: "samples",
	WAVETABLES: "wavetables",
	DAW: "daw",
};
const STARTUP_STATE = {
	IDLE: "idle",
	STARTING: "starting",
	FAILED: "failed",
	STARTED: "started",
};

const elSplash = $( "#splashScreen" );
const elButton = elSplash.$query( "button" );
const elFirefox = elSplash.$query( "[data-alert=firefox]" );
const elFailure = elSplash.$query( "[data-alert=failure]" );

let phase = STARTUP_STATE.IDLE;
let attempt = null; // the in-flight startup chain, if any
let daw = null;     // the DAW object, created at most once

// The gs-utils wrapper is used when available; the fallbacks below keep this
// script usable with a minimal `$` implementation (tests, light hosts).
function elNode( el ) {
	return el && ( el.$_elem0 || el[ 0 ] ) || null;
}
function setAttr( el, name, value ) {
	if ( !el ) {
		return;
	}
	if ( typeof el.$setAttr === "function" ) {
		el.$setAttr( name, value );
	} else {
		const node = elNode( el );

		node && node.setAttribute && node.setAttribute( name, value );
	}
}
function addAttr( el, name ) {
	if ( !el ) {
		return;
	}
	if ( typeof el.$addAttr === "function" ) {
		el.$addAttr( name );
	} else {
		setAttr( el, name, "" );
	}
}
function rmAttr( el, name ) {
	if ( !el ) {
		return;
	}
	if ( typeof el.$rmAttr === "function" ) {
		el.$rmAttr( name );
	} else if ( typeof el.$removeAttr === "function" ) {
		el.$removeAttr( name );
	} else {
		const node = elNode( el );

		node && node.removeAttribute && node.removeAttribute( name );
	}
}
function setDisplay( el, display ) {
	if ( !el ) {
		return;
	}
	if ( typeof el.$css === "function" ) {
		el.$css( "display", display );
	} else {
		const node = elNode( el );

		node && node.style && ( node.style.display = display );
	}
}
function setText( el, text ) {
	if ( !el ) {
		return;
	}
	if ( typeof el.$text === "function" ) {
		el.$text( text );
	} else {
		const node = elNode( el );

		node && ( node.textContent = text );
	}
}
function disableButton( disabled ) {
	elButton.$disabled( disabled );
}

// A step is executed at most one successful time:
//   - pending  : everybody awaits the same promise (no duplicated task);
//   - fulfilled: the promise is kept, the task is never run again;
//   - rejected : the memo is dropped, so a retry can run this step again.
function memoizedStep( fn ) {
	let promise = null;
	let fulfilled = false;

	const step = () => {
		if ( !promise ) {
			promise = Promise.resolve()
				.then( fn )
				.then( res => {
					fulfilled = true;
					return res;
				} )
				.catch( cause => {
					promise = null;
					throw cause;
				} );
		}
		return promise;
	};

	// A fulfilled step never needs to be reported again on a retry.
	step.done = () => fulfilled;

	return step;
}

// Remove the script tags previously added for `src` and not loaded yet: a
// failed attempt must not leave a pending load behind, otherwise a retry would
// stack a second loading task for the same resource.
function removeStaleScripts( src ) {
	if ( typeof document === "undefined" || !document.head ||
		typeof document.head.querySelectorAll !== "function" ) {
		return;
	}
	document.head.querySelectorAll( "script[src]" ).forEach( node => {
		if ( node.src && node.src.indexOf( src ) !== -1 ) {
			node.remove();
		}
	} );
}

// `GSUloadJSFile` resolves on the script "load" event and never rejects, so a
// real loading error (404, network, ...) would leave the chain pending
// forever. This keeps the same loading step, but also listens to the script
// "error" event so a broken resource really rejects, can be retried, and does
// not leave a broken tag behind.
function loadAsset( src ) {
	removeStaleScripts( src );
	return new Promise( ( resolve, reject ) => {
		const hasWindow = typeof window !== "undefined" && !!window.addEventListener;
		let settled = false;
		const onError = e => {
			const node = e && e.target;

			if ( node && node.tagName === "SCRIPT" && node.src && node.src.indexOf( src ) !== -1 ) {
				node.remove && node.remove();
				fail( new Error( `unable to load "${ src }"` ) );
			}
		};
		const cleanup = () => {
			if ( hasWindow ) {
				window.removeEventListener( "error", onError, true );
			}
		};
		const fail = err => {
			if ( !settled ) {
				settled = true;
				cleanup();
				reject( err );
			}
		};

		if ( hasWindow ) {
			window.addEventListener( "error", onError, true );
		}
		try {
			Promise.resolve( GSUloadJSFile( src ) ).then( res => {
				if ( !settled ) {
					settled = true;
					cleanup();
					resolve( res );
				}
			}, fail );
		} catch ( err ) {
			fail( err );
		}
	} );
}

// .............................................................................
// The startup steps, each of them successful at most once.
const resumeAudio = memoizedStep( () => gswaContext.$resume() );
const loadSamples = memoizedStep( () => loadAsset( "assets/gsuiLibrarySamples-v1.js" ) );
const loadWavelets = memoizedStep( () => loadAsset( "assets/gsuiWaveletList-v1.js" ) );
const initDAW = memoizedStep( async () => {
	// The interface object is built once. If `$init` failed, the half-built
	// instance is dropped and the retry builds a fresh one, so no duplicated
	// or half-initialized interface is kept around.
	if ( !daw ) {
		daw = new GSDAW();
	}
	try {
		await Promise.resolve( daw.$init() );
	} catch ( cause ) {
		daw = null;
		throw cause;
	}
} );

// .............................................................................
function setPhase( name ) {
	phase = name;
	setAttr( elSplash, "data-start-phase", name );
}

function showFailure( step, cause ) {
	phase = STARTUP_STATE.FAILED;
	setAttr( elSplash, "data-start-phase", STARTUP_STATE.FAILED );
	addAttr( elSplash, "data-start-failed" );
	if ( step ) {
		setAttr( elSplash, "data-start-failed-at", step );
	}
	rmAttr( elSplash, "data-starting" );
	setDisplay( elFailure, "block" );
	if ( elFailure ) {
		const msg = cause && cause.message ? cause.message : String( cause || "unknown error" );

		setText( elFailure, `Startup failed while ${ step || "starting" } (${ msg })` );
	}
	disableButton( false );
	console.error( `startup failed at "${ step || "unknown" }"`, cause );
}

function hideFailure() {
	rmAttr( elSplash, "data-start-failed" );
	rmAttr( elSplash, "data-start-failed-at" );
	setDisplay( elFailure, "none" );
}

function showStarted() {
	phase = STARTUP_STATE.STARTED;
	setAttr( elSplash, "data-start-phase", STARTUP_STATE.STARTED );
	rmAttr( elSplash, "data-starting" );
	hideFailure();
	elSplash.$addAttr( "data-started" );
	GSUsetTimeout( () => elSplash.$remove(), .8 );
}

async function runStep( id, task ) {
	// A step already fulfilled by a previous attempt is not reported again:
	// the retry only shows the phase it actually has to (re)perform.
	if ( !task.done() ) {
		setPhase( id );
	}
	try {
		return await task();
	} catch ( cause ) {
		const err = new Error( `startup step failed: ${ id }` );

		err.step = id;
		err.cause = cause;
		throw err;
	}
}

async function runStartup() {
	// Let the browser paint the "starting..." state, and keep the audio
	// context resumption attached to the user gesture.
	await new Promise( resolve => GSUsetTimeout( resolve, .1 ) );
	await runStep( STARTUP_STEP.RESUME, resumeAudio );
	await runStep( STARTUP_STEP.SAMPLES, loadSamples );
	await runStep( STARTUP_STEP.WAVETABLES, loadWavelets );
	await runStep( STARTUP_STEP.DAW, initDAW );
	showStarted();
}

function start() {
	if ( phase === STARTUP_STATE.STARTED ) {
		return Promise.resolve( true );
	}
	if ( attempt ) {
		// The first start or a retry is already in progress: report the
		// current attempt instead of stacking another loading chain.
		return attempt;
	}

	hideFailure();
	addAttr( elSplash, "data-starting" );
	setPhase( STARTUP_STATE.STARTING );
	disableButton( true );

	attempt = runStartup().then(
		() => {
			attempt = null;
			return true;
		},
		err => {
			attempt = null;
			showFailure( err && err.step, err && err.cause );
			return false;
		}
	);

	return attempt;
}

GSUonFirefox
	? elFirefox.$css( "display", "block" )
	: elFirefox.$remove();
elSplash.$addAttr( "data-loaded" );
elButton
	.$onclick( () => start() )
	.$disabled( false );
