/**
 * Adapted from Matt Diamonds abandoned recorderjs.
 * Separated from /node_modules to allow inlining of worker through Webpack.
 */
interface RecorderRequest {
    command: "init" | "record" | "exportWAV" | "getBuffer" | "clear";
    config?: {
        sampleRate: number;
        numChannels?: number;
    }
    buffer?: Float32Array[];
    type?: string;
};

const BYTES_PER_SAMPLE = 2; // 16-bit PCM output
const DEFAULT_CHANNELS = 2;

export {}; // treat this file as a module (allows type checking of dynamic imports)

let recLength = 0;
let sampleRate: number;
let numChannels = DEFAULT_CHANNELS;
let recData: RecorderRequest;
let recBuffers: Float32Array[][] = [];

self.addEventListener( "message", ( event: MessageEvent ): void => {
    recData = event.data as RecorderRequest;

    switch ( recData.command ) {
        default:
            break;
        case "init":
            init( recData.config );
            break;
        case "record":
            record( recData.buffer );
            break;
        case "exportWAV":
            exportWAV( recData.type );
            break;
        case "getBuffer":
            getBuffer();
            break;
        case "clear":
            clear();
            break;
    }
});

/* internal methods */

function init( config: { sampleRate: number, numChannels?: number } ): void {
    sampleRate  = config.sampleRate;
    numChannels = config.numChannels ?? DEFAULT_CHANNELS;
}

function record( inputBuffer: Float32Array[] ): void {
    numChannels = inputBuffer.length;
    for ( let channel = 0; channel < numChannels; ++channel ) {
        if ( !recBuffers[ channel ]) {
            recBuffers[ channel ] = [];
        }
        recBuffers[ channel ].push( inputBuffer[ channel ]);
    }
    recLength += inputBuffer[ 0 ].length;
}

function exportWAV( type: string ): void {
    // use the channel count of the actually recorded data, falling back to
    // the configured amount when exporting without a prior recording
    const channelCount = recLength > 0 ? recBuffers.length : numChannels;
    const merged       = recBuffers.map( buffers => mergeBuffers( buffers, recLength ));
    const interleaved  = interleave( merged, recLength, channelCount );
    const dataview     = encodeWAV( interleaved, channelCount );
    const audioBlob    = new Blob([ dataview ], { type });

    // free the recorded buffers so the next recording starts from a clean slate
    // and repeated exports don't return previously exported audio
    clear();

    self.postMessage( audioBlob );
}

function getBuffer(): void {
    const buffers: Float32Array[] = recBuffers.map( channelBuffers => mergeBuffers( channelBuffers, recLength ));

    self.postMessage( buffers );
}

function clear(): void {
    recLength  = 0;
    recBuffers = [];
}

function mergeBuffers( recBuffers: Float32Array[], recLength: number ): Float32Array {
    const result = new Float32Array( recLength );
    let offset = 0;
    for ( let i = 0; i < recBuffers.length; i++ ) {
        result.set( recBuffers[ i ], offset );
        offset += recBuffers[ i ].length;
    }
    return result;
}

function interleave( channelBuffers: Float32Array[], recLength: number, numChannels: number ): Float32Array {
    const result = new Float32Array( recLength * numChannels );

    for ( let i = 0; i < recLength; ++i ) {
        for ( let channel = 0; channel < numChannels; ++channel ) {
            result[ i * numChannels + channel ] = channelBuffers[ channel ][ i ];
        }
    }
    return result;
}

function floatTo16BitPCM( view: DataView, offset: number, input: Float32Array ): void {
    for ( let i = 0; i < input.length; i++, offset += 2 ) {
        const s = Math.max( -1, Math.min( 1, input[ i ]));
        view.setInt16( offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true );
    }
}

function writeString( view: DataView, offset: number, string: string ): void {
    for ( let i = 0; i < string.length; i++ ) {
        view.setUint8( offset + i, string.charCodeAt( i ));
    }
}

function encodeWAV( samples: Float32Array, numChannels: number ): DataView {
    const blockAlign = numChannels * BYTES_PER_SAMPLE;
    const buffer = new ArrayBuffer( 44 + samples.length * BYTES_PER_SAMPLE );
    const view   = new DataView( buffer );

    /* RIFF identifier */
    writeString( view, 0, "RIFF" );
    /* RIFF chunk length */
    view.setUint32( 4, 36 + samples.length * BYTES_PER_SAMPLE, true );
    /* RIFF type */
    writeString( view, 8, "WAVE" );
    /* format chunk identifier */
    writeString( view, 12, "fmt " );
    /* format chunk length */
    view.setUint32( 16, 16, true );
    /* sample format (raw) */
    view.setUint16( 20, 1, true );
    /* channel count */
    view.setUint16( 22, numChannels, true );
    /* sample rate */
    view.setUint32( 24, sampleRate, true );
    /* byte rate (sample rate * block align) */
    view.setUint32( 28, sampleRate * blockAlign, true );
    /* block align (channel count * bytes per sample) */
    view.setUint16( 32, blockAlign, true );
    /* bits per sample */
    view.setUint16( 34, BYTES_PER_SAMPLE * 8, true );
    /* data chunk identifier */
    writeString( view, 36, "data" );
    /* data chunk length */
    view.setUint32( 40, samples.length * BYTES_PER_SAMPLE, true );

    floatTo16BitPCM( view, 44, samples );

    return view;
}
