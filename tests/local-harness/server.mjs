// Minimal static server for the local mock site with two control endpoints:
//   POST /__control/fail   { "gsuiLibrarySamples": "boom", ... } -> 500 next request
//   POST /__control/clear                                   -> clear failures
//   GET  /__caches                                          -> caches seen by the SW
// A failed resource returns HTTP 500 only ONCE, then the failure is consumed
// (the page's <script> onerror fires, exactly like a real network failure).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join( dirname( fileURLToPath( import.meta.url ) ), "runtime" );
const port = Number( process.env.PORT || 8123 );
const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};
const oneShotFails = new Map(); // url-substring -> message

const send = ( res, code, body, type = "text/plain" ) => {
	res.writeHead( code, { "content-type": type } );
	res.end( body );
};
const server = createServer( async ( req, res ) => {
	const url = new URL( req.url, `http://localhost:${ port }` );

	if ( req.method === "POST" && url.pathname === "/__control/fail" ) {
		const chunks = [];
		for await ( const c of req ) { chunks.push( c ); }
		const map = JSON.parse( Buffer.concat( chunks ).toString() || "{}" );
		for ( const [ k, v ] of Object.entries( map ) ) { oneShotFails.set( k, v ); }
		return send( res, 200, "ok" );
	}
	if ( req.method === "POST" && url.pathname === "/__control/clear" ) {
		oneShotFails.clear();
		return send( res, 200, "ok" );
	}
	let path = decodeURIComponent( url.pathname );
	const hit = [ ...oneShotFails.keys() ].find( k => path.includes( k ) );
	if ( hit ) {
		const msg = oneShotFails.get( hit );
		oneShotFails.delete( hit );
		return send( res, 500, `mock failure: ${ msg }` );
	}
	if ( path === "/" ) { path = "/index.html"; }
	const file = normalize( join( root, path ) );
	if ( !file.startsWith( root ) ) { return send( res, 403, "forbidden" ); }
	try {
		const body = await readFile( file );
		const headers = { "content-type": MIME[ extname( file ) ] || "application/octet-stream" };
		// The browser must always revalidate the service worker script so a
		// rebuilt runtime (new version) triggers the update flow.
		if ( file.endsWith( "serviceWorker.js" ) ) {
			headers[ "cache-control" ] = "no-store";
		}
		res.writeHead( 200, headers );
		res.end( body );
	} catch {
		send( res, 404, "not found" );
	}
} );

server.listen( port, () => console.log( `mock server on http://localhost:${ port }` ) );
