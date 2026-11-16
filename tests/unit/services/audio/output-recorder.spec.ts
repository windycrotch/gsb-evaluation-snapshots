import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";

/**
 * These tests run the actual recorder.worker source in-process by stubbing the
 * `self` global it uses to communicate. The `?worker` import used by OutputRecorder
 * is mocked with a Worker-like class that bridges messages to that real worker logic,
 * so both the OutputRecorder flow and the WAV encoding are covered.
 */

// shared bridge between the mocked Worker instances and the real worker module
const workerBridge = vi.hoisted(() => ({
    messageListener: null as (( event: MessageEvent ) => void ) | null,
    responseHandler: null as (( data: unknown ) => void ) | null,
}));

// capture Blob constructor arguments instead of relying on jsdom Blob internals
class MockBlob {
    public readonly parts: unknown[];
    public readonly type: string;

    constructor( parts: unknown[], options?: { type?: string }) {
        this.parts = parts;
        this.type  = options?.type ?? "";
    }
}
vi.stubGlobal( "Blob", MockBlob );

// route the real worker module's `self` into the bridge
vi.stubGlobal( "self", {
    addEventListener: ( type: string, listener: ( event: MessageEvent ) => void ): void => {
        if ( type === "message" ) {
            workerBridge.messageListener = listener;
        }
    },
    postMessage: ( data: unknown ): void => {
        // workers respond asynchronously, deliver the response on the microtask queue
        const handler = workerBridge.responseHandler;
        queueMicrotask(() => handler?.( data ));
    },
});

// evaluate the actual worker source against the stubbed `self`
beforeAll( async () => {
    await import( "@/workers/recorder.worker" );
});

// mock the Worker constructor used by OutputRecorder
vi.mock( "@/workers/recorder.worker?worker", () => ({
    default: class MockWorker {
        public onmessage: (( event: MessageEvent ) => void ) | null = null;
        public terminated = false;

        constructor() {
            workerBridge.responseHandler = ( data: unknown ): void => {
                this.onmessage?.({ data } as MessageEvent );
            };
        }
        postMessage( data: unknown ): void {
            workerBridge.messageListener?.({ data } as MessageEvent );
        }
        terminate(): void {
            this.terminated = true;
        }
    }
}));

// eslint-disable-next-line import/first
import OutputRecorder from "@/services/audio/output-recorder";

/* test helpers */

const SAMPLE_RATE = 44100;
const HEADER_LENGTH = 44;
const BYTES_PER_SAMPLE = 2;

type MockProcessorNode = {
    onaudioprocess: (( event: unknown ) => void ) | null;
    connect: ReturnType<typeof vi.fn>;
};

function createMockAudioEnvironment( sampleRate = SAMPLE_RATE ) {
    const processorNode: MockProcessorNode = {
        onaudioprocess: null,
        connect: vi.fn(),
    };
    const context = {
        sampleRate,
        destination: {},
        createScriptProcessor: vi.fn(() => processorNode ),
    };
    const source = {
        context,
        connect: vi.fn(),
    };
    return { source, context, processorNode };
}

function fireAudioProcess( processorNode: MockProcessorNode, channels: Float32Array[] ): void {
    processorNode.onaudioprocess?.({
        inputBuffer: {
            numberOfChannels: channels.length,
            getChannelData: ( index: number ) => channels[ index ],
        },
    });
}

function flushWorker(): Promise<void> {
    return new Promise( resolve => setTimeout( resolve, 0 ));
}

function getExportedView( blob: MockBlob ): DataView {
    return blob.parts[ 0 ] as DataView;
}

/* WAV header readers */

const readChannelCount = ( view: DataView ): number => view.getUint16( 22, true );
const readSampleRate   = ( view: DataView ): number => view.getUint32( 24, true );
const readByteRate     = ( view: DataView ): number => view.getUint32( 28, true );
const readBlockAlign   = ( view: DataView ): number => view.getUint16( 32, true );
const readDataLength   = ( view: DataView ): number => view.getUint32( 40, true );

/* tests */

describe( "OutputRecorder", () => {
    let source: ReturnType<typeof createMockAudioEnvironment>[ "source" ];
    let processorNode: MockProcessorNode;
    let recorded: MockBlob[];
    let recorder: OutputRecorder;

    beforeEach(() => {
        // reset the shared worker state so each test starts from a clean slate
        workerBridge.messageListener?.({ data: { command: "clear" } } as MessageEvent );

        const environment = createMockAudioEnvironment();
        source        = environment.source;
        processorNode = environment.processorNode;

        recorded = [];
        recorder = new OutputRecorder( source as unknown as AudioNode, {
            callback: ( blob: Blob ) => recorded.push( blob as unknown as MockBlob ),
        });
    });

    it( "should export a WAV whose data length matches the recorded sample count", async () => {
        recorder.record();
        fireAudioProcess( processorNode, [ new Float32Array( 512 ), new Float32Array( 512 ) ]);
        fireAudioProcess( processorNode, [ new Float32Array( 256 ), new Float32Array( 256 ) ]);
        recorder.stop();

        // chunks arriving after stop() should not be recorded
        fireAudioProcess( processorNode, [ new Float32Array( 128 ), new Float32Array( 128 ) ]);

        recorder.export();
        await flushWorker();

        expect( recorded ).toHaveLength( 1 );

        const view = getExportedView( recorded[ 0 ]);
        const recordedSamplesPerChannel = 512 + 256;

        expect( readDataLength( view )).toEqual( recordedSamplesPerChannel * 2 * BYTES_PER_SAMPLE );
        expect( view.byteLength ).toEqual( HEADER_LENGTH + recordedSamplesPerChannel * 2 * BYTES_PER_SAMPLE );
        expect( readChannelCount( view )).toEqual( 2 );
        expect( readSampleRate( view )).toEqual( SAMPLE_RATE );
        expect( readByteRate( view )).toEqual( SAMPLE_RATE * 4 );
        expect( readBlockAlign( view )).toEqual( 4 );
    });

    it( "should interleave the recorded channels as 16-bit PCM in the exported WAV", async () => {
        recorder.record();
        fireAudioProcess( processorNode, [
            new Float32Array([ 1, -1 ]),
            new Float32Array([ 0.5, -0.5 ]),
        ]);
        recorder.stop();
        recorder.export();
        await flushWorker();

        const view = getExportedView( recorded[ 0 ]);

        expect( readDataLength( view )).toEqual( 4 * BYTES_PER_SAMPLE );
        // interleaved order: L0, R0, L1, R1 (values truncated to 16-bit integers)
        expect( view.getInt16( HEADER_LENGTH + 0, true )).toEqual( 0x7FFF );
        expect( view.getInt16( HEADER_LENGTH + 2, true )).toEqual( Math.trunc( 0.5 * 0x7FFF ));
        expect( view.getInt16( HEADER_LENGTH + 4, true )).toEqual( -0x8000 );
        expect( view.getInt16( HEADER_LENGTH + 6, true )).toEqual( Math.trunc( -0.5 * 0x8000 ));
    });

    it( "should only contain the newly recorded data when recording again after an export", async () => {
        recorder.record();
        fireAudioProcess( processorNode, [ new Float32Array( 512 ), new Float32Array( 512 ) ]);
        recorder.stop();
        recorder.export();
        await flushWorker();

        expect( recorded ).toHaveLength( 1 );
        expect( readDataLength( getExportedView( recorded[ 0 ]))).toEqual( 512 * 2 * BYTES_PER_SAMPLE );

        // record a second take within the same session
        recorder.record();
        fireAudioProcess( processorNode, [ new Float32Array( 256 ), new Float32Array( 256 ) ]);
        recorder.stop();
        recorder.export();
        await flushWorker();

        expect( recorded ).toHaveLength( 2 );

        const view = getExportedView( recorded[ 1 ]);
        // the second export must not contain the first recording's samples
        expect( readDataLength( view )).toEqual( 256 * 2 * BYTES_PER_SAMPLE );
        expect( view.byteLength ).toEqual( HEADER_LENGTH + 256 * 2 * BYTES_PER_SAMPLE );
    });

    it( "should only generate a single file when export is requested multiple times for one recording", async () => {
        recorder.record();
        fireAudioProcess( processorNode, [ new Float32Array( 512 ), new Float32Array( 512 ) ]);
        recorder.stop();

        recorder.export();
        recorder.export(); // duplicate request while the first export is pending
        await flushWorker();

        expect( recorded ).toHaveLength( 1 );
    });

    it( "should export a valid WAV with an empty data chunk when nothing was recorded", async () => {
        recorder.export();
        await flushWorker();

        expect( recorded ).toHaveLength( 1 );

        const view = getExportedView( recorded[ 0 ]);

        expect( readDataLength( view )).toEqual( 0 );
        expect( view.byteLength ).toEqual( HEADER_LENGTH );
        expect( readChannelCount( view )).toEqual( 2 );
        expect( readSampleRate( view )).toEqual( SAMPLE_RATE );
        expect( readByteRate( view )).toEqual( SAMPLE_RATE * 4 );
        expect( readBlockAlign( view )).toEqual( 4 );
    });

    it( "should write the correct channel count, byte rate and block align for mono input", async () => {
        recorder.record();
        fireAudioProcess( processorNode, [ new Float32Array( 100 ) ]);
        recorder.stop();
        recorder.export();
        await flushWorker();

        const view = getExportedView( recorded[ 0 ]);

        expect( readChannelCount( view )).toEqual( 1 );
        expect( readBlockAlign( view )).toEqual( 1 * BYTES_PER_SAMPLE );
        expect( readByteRate( view )).toEqual( SAMPLE_RATE * BYTES_PER_SAMPLE );
        expect( readDataLength( view )).toEqual( 100 * BYTES_PER_SAMPLE );
        expect( view.byteLength ).toEqual( HEADER_LENGTH + 100 * BYTES_PER_SAMPLE );
    });
});
