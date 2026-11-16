"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

{
	const el = $( "#splashScreen" );
	const elFirefox = el.$query( "[data-alert=firefox]" );
	const elStart = el.$query( "#splashScreen-start" );
	const elSplash = document.querySelector( "#splashScreen" );
	const elStatus = elSplash.querySelector( "#splashScreen-status" );
	const elErrorMsg = elSplash.querySelector( "#splashScreen-errorMsg" );
	const elRetry = elSplash.querySelector( "#splashScreen-retry" );
	const elSWWarning = elSplash.querySelector( "#splashScreen-swWarning" );
	const elSteps = {};

	elSplash.querySelectorAll( "#splashScreen-steps > li" ).forEach( li => {
		elSteps[ li.dataset.step ] = li;
	} );

	// The startup chain, in its original order. Each step runs at most once:
	// a failure stops the chain and a retry resumes from the failed step.
	const startupSteps = [
		{ id: "audio",    label: "audio context",     run: () => gswaContext.$resume() },
		{ id: "samples",  label: "sample library",    run: () => GSUloadJSFile( "assets/gsuiLibrarySamples-v1.js" ) },
		{ id: "wavelets", label: "wavetable library", run: () => GSUloadJSFile( "assets/gsuiWaveletList-v1.js" ) },
		{ id: "ui",       label: "user interface",    run: () => { const daw = new GSDAW(); daw.$init(); } },
	];
	let startupStepIdx = 0;

	function runStartupSteps() {
		if ( startupStepIdx >= startupSteps.length ) {
			el.$addAttr( "data-started" );
			GSUsetTimeout( () => el.$remove(), .8 );
			return;
		}
		const step = startupSteps[ startupStepIdx ];

		elSplash.removeAttribute( "data-error" );
		elStatus.textContent = `loading ${ step.label }...`;
		elSteps[ step.id ].dataset.state = "running";
		Promise.resolve()
			.then( step.run )
			.then( () => {
				elSteps[ step.id ].dataset.state = "done";
				++startupStepIdx;
				runStartupSteps();
			} )
			.catch( err => {
				console.error( `[startup] step "${ step.id }" (${ step.label }) failed:`, err );
				elSteps[ step.id ].dataset.state = "error";
				elStatus.textContent = "";
				elErrorMsg.textContent = `startup failed while loading: ${ step.label }`;
				elSplash.setAttribute( "data-error", "" );
			} );
	}

	elRetry.addEventListener( "click", () => runStartupSteps() );

	// Surface serviceWorker precache problems (missing offline assets) on the splash screen.
	if ( "serviceWorker" in navigator ) {
		navigator.serviceWorker.addEventListener( "message", e => {
			const missing = e.data?.type === "precache-status" ? e.data.missing : null;

			if ( missing?.length ) {
				elSWWarning.textContent = `offline cache incomplete, missing: ${ missing.join( ", " ) }`;
				elSplash.setAttribute( "data-sw-warning", "" );
			}
		} );
		navigator.serviceWorker.ready.then( reg => {
			reg.active?.postMessage( { type: "precache-status" } );
		} );
	}

	new Promise( resolve => {
		GSUonFirefox
			? elFirefox.$css( "display", "block" )
			: elFirefox.$remove();
		el.$addAttr( "data-loaded" );
		elStart
			.$onclick( () => {
				elStart.$disabled( true );
				el.$addAttr( "data-starting" );
				GSUsetTimeout( resolve, .1 );
			} )
			.$disabled( false );
	} )
		.then( () => runStartupSteps() );
}
