// Builds the local mock site from the real production sources (src/run.js,
// src/splashScreen.html, serviceWorker.js) plus hand-written mocks for the
// git submodules that are not available locally (gs-utils, gswaContext,
// GSDAW, assets...). Run with: node build-site.mjs [version]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join( dirname( fileURLToPath( import.meta.url ) ), "../.." );
const out = join( root, "tests/local-harness/runtime" );
const conf = JSON.parse( readFileSync( join( root, "build-conf.json" ), "utf8" ) );
const version = process.argv[ 2 ] || conf.version;
const subst = s => s.split( "{{GSDAW-VERSION}}" ).join( version );

mkdirSync( join( out, "assets/fonts" ), { recursive: true } );
mkdirSync( join( out, "assets/logo" ), { recursive: true } );

// 1. Real production sources, with the same token substitution the real
//    builder performs on the splash screen and the service worker.
//    Harness-only addition: the mock site is served as loose scripts
//    (run.js/mock-utils.js) that a real build would inline into index.html,
//    so they must be precached for offline refresh to work.
const serviceWorker = subst( readFileSync( join( root, "serviceWorker.js" ), "utf8" ) )
	.replace( "const PRECACHE_URLS = [",
		"const PRECACHE_URLS = [\n\t\"/run.js\",\n\t\"/mock-utils.js\"," );
const splash = subst( readFileSync( join( root, "src/splashScreen.html" ), "utf8" ) );
const runJs = readFileSync( join( root, "src/run.js" ), "utf8" );

writeFileSync( join( out, "serviceWorker.js" ), serviceWorker );
writeFileSync( join( out, "run.js" ), runJs );
writeFileSync( join( out, "manifest.json" ), JSON.stringify( {
	name: "GridSound local harness",
	short_name: "GSh",
	start_url: "./",
	scope: "./",
	display: "standalone",
}, null, "\t" ) );

// 2. Placeholder assets referenced by the service worker precache list and
//    by the splash screen markup/css.
const placeholders = [
	"assets/ico.svg",
	"assets/logo/gs-gs-logo.svg",
	"assets/logo/gs-gridsound-logo-animated.svg",
	"assets/gsuiLibrarySamples-v1.js",
	"assets/gsuiWaveletList-v1.js",
	"assets/fonts/fa-brands-400.woff2",
	"assets/fonts/fa-duotone-900.woff2",
	"assets/fonts/unica-one-400-latin.woff2",
	"assets/fonts/montserrat-500-latin.woff2",
	"assets/fonts/montserrat-700-latin.woff2",
	"assets/fonts/inconsolata-400-latin.woff2",
];
for ( const p of placeholders ) {
	const isJs = p.endsWith( ".js" );
	writeFileSync( join( out, p ), isJs
		? `// mock for ${ p }\nwindow.__gs.loaded.push( ${ JSON.stringify( p ) } );\n`
		: p.endsWith( ".svg" )
			? `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`
			: "mock-font" );
}

// 3. Mock of the submodule globals used by run.js
//    (GSUloadJSFile, gswaContext, GSUonFirefox, GSDAW).
const mockUtils = `
"use strict";
window.__gs = {
	loaded: [],
	resumeCalls: 0,
	dawConstructed: 0,
	dawInitCalls: 0,
	fail: {},          // url-substring -> error message, configured per test
	events: [],
};
window.GSUonFirefox = false;
window.gswaContext = {
	$resume() {
		window.__gs.resumeCalls++;
		return Promise.resolve();
	},
};
// Mirrors a real dynamic <script> loader: a real network request is made,
// so service-worker caching and offline fallback are exercised.
window.GSUloadJSFile = url => new Promise( ( resolve, reject ) => {
	const s = document.createElement( "script" );
	s.src = url;
	s.onload = () => { s.remove(); resolve(); };
	s.onerror = () => {
		s.remove();
		const key = Object.keys( window.__gs.fail ).find( k => url.includes( k ) );
		reject( new Error( key
			? window.__gs.fail[ key ]
			: "Failed to load " + url ) );
	};
	document.head.appendChild( s );
} );
window.GSDAW = class GSDAW {
	constructor() { window.__gs.dawConstructed++; }
	$init() {
		window.__gs.dawInitCalls++;
		const msg = window.__gs.fail[ "GSDAW.$init" ];
		if ( msg ) { throw new Error( msg ); }
	}
};
`;
writeFileSync( join( out, "mock-utils.js" ), mockUtils );

// 4. index.html assembling the real splash markup + real run.js.
const indexHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>GridSound local harness</title>
<style>
body { margin: 0; min-height: 100vh; background: #222; }
#splashScreen { position: static; min-height: 100vh; }
</style>
</head>
<body>
${ splash }
<script src="mock-utils.js"></script>
<script src="run.js"></script>
<script>
// ?nosw=1 isolates the page state machine from service-worker install races.
if ( "serviceWorker" in navigator && !new URLSearchParams( location.search ).has( "nosw" ) ) {
	navigator.serviceWorker.register( "serviceWorker.js" ).catch( console.error );
}
for ( const t of [ "splash:ready", "splash:phase", "splash:error", "splash:done" ] ) {
	document.getElementById( "splashScreen" ).addEventListener( t, e =>
		window.__gs.events.push( { type: t, detail: e.detail } ) );
}
</script>
</body>
</html>
`;
writeFileSync( join( out, "index.html" ), indexHtml );
copyFileSync( join( root, "manifest.json" ), join( out, "manifest.real.json" ) );

console.log( `mock site built in tests/local-harness/runtime (version ${ version })` );
