"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

( () => {
	const PHASES = [
		{ id: "resume",    label: "Resuming audio" },
		{ id: "samples",   label: "Loading sample library" },
		{ id: "wavetable", label: "Loading wavetables" },
		{ id: "init",      label: "Initializing GSDAW" },
	];
	const el = document.getElementById( "splashScreen" );
	const elBtn = el.querySelector( "button" );
	const elErr = el.querySelector( "[data-error]" );
	const elErrPhase = el.querySelector( "[data-error-phase]" );
	const elErrMsg = el.querySelector( "[data-error-msg]" );
	const elRetry = el.querySelector( "[data-retry]" );
	const state = {
		status: "idle", // idle | starting | error | done
		phase: 0,       // currently running / last failed phase index
		error: null,    // { phase, message }
	};
	let chain = null; // the single in-flight startup chain, guards against re-entry

	const dispatch = ( type, detail ) =>
		el.dispatchEvent( new CustomEvent( type, { detail } ) );

	const render = () => {
		const { status, phase, error } = state;

		el.dataset.state = status;
		el.dataset.phase = PHASES[ phase ].id;
		elBtn.disabled = status === "starting" || status === "done";
		if ( status === "error" ) {
			elErrPhase.textContent = PHASES[ error.phase ].label;
			elErrMsg.textContent = error.message;
			elErr.hidden = false;
		} else {
			elErr.hidden = true;
		}
	};

	const runPhase = i => {
		switch ( PHASES[ i ].id ) {
			case "resume":    return gswaContext.$resume();
			case "samples":   return GSUloadJSFile( "assets/gsuiLibrarySamples-v1.js" );
			case "wavetable": return GSUloadJSFile( "assets/gsuiWaveletList-v1.js" );
			case "init": {
				const daw = new GSDAW();

				daw.$init();
				return daw;
			}
		}
	};

	const runFrom = first => {
		if ( chain || state.status === "done" ) {
			return chain || Promise.resolve();
		}
		state.status = "starting";
		state.error = null;
		render();
		chain = ( async () => {
			for ( let i = first; i < PHASES.length; ++i ) {
				state.phase = i;
				render();
				dispatch( "splash:phase", { phase: PHASES[ i ].id, index: i } );
				try {
					await runPhase( i );
				} catch ( err ) {
					state.status = "error";
					state.error = {
						phase: i,
						message: err && ( err.message || String( err ) ) || "Unknown error",
					};
					render();
					dispatch( "splash:error", {
						phase: PHASES[ i ].id,
						index: i,
						message: state.error.message,
					} );
					chain = null;
					return;
				}
			}
			state.status = "done";
			render();
			dispatch( "splash:done", null );
			el.setAttribute( "data-started", "" );
			setTimeout( () => el.remove(), 800 );
		} )();
		return chain;
	};

	const GSUonFirefoxRef = window.GSUonFirefox;
	const elFirefox = el.querySelector( "[data-alert=firefox]" );

	if ( GSUonFirefoxRef ) {
		elFirefox.style.display = "block";
	} else {
		elFirefox.remove();
	}
	elBtn.addEventListener( "click", () => runFrom( state.error ? state.error.phase : 0 ) );
	elRetry.addEventListener( "click", () => runFrom( state.error.phase ) );
	el.setAttribute( "data-loaded", "" );
	elBtn.disabled = false;
	render();
	dispatch( "splash:ready", null );
} )();
