import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const createParam = () => ({
        value: 0,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
    });
    const createNode = () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
    });
    const mockAudioContext = {
        sampleRate: 44100,
        currentTime: 0,
        destination: {},
        createBuffer: vi.fn(( _channels: number, length: number ) => ({
            getChannelData: () => new Float32Array( length ),
        })),
        createPeriodicWave: vi.fn(() => ({})),
        createBiquadFilter: vi.fn(() => ({ ...createNode(), type: "", frequency: createParam(), gain: createParam() })),
        createDynamicsCompressor: vi.fn(() => createNode()),
        createAnalyser: vi.fn(() => createNode()),
    };
    return {
        mockAudioContext,
        createGainNode: vi.fn(() => ({ ...createNode(), gain: createParam() })),
        createStereoPanner: vi.fn(() => ({ ...createNode(), pan: createParam() })),
        saveAsFile: vi.fn(),
        blobToResource: vi.fn(() => "blob:mock" ),
        disposeResource: vi.fn(),
    };
});

vi.mock( "@/services/audio/webaudio-helper", () => ({
    init: vi.fn(() => Promise.resolve( mocks.mockAudioContext )),
    startOscillation: vi.fn(),
    stopOscillation: vi.fn(),
    setValue: vi.fn(),
    createGainNode: mocks.createGainNode,
    createStereoPanner: mocks.createStereoPanner,
    createPWM: vi.fn(),
    createWaveTableFromGraph: vi.fn(() => ({})),
    createTimer: vi.fn(),
    beep: vi.fn(),
    supports: vi.fn(() => false ),
    createOfflineAudioContext: vi.fn(),
    isOscillatorNode: vi.fn(() => false ),
    isAudioBufferSourceNode: vi.fn(() => false ),
}));

vi.mock( "@/model/factories/module-factory", () => ({
    default: {
        createOverdrive: vi.fn(() => ({})),
        createEQ: vi.fn(() => ({})),
        createFilter: vi.fn(() => ({})),
        createDelay: vi.fn(() => ({})),
        applyConfiguration: vi.fn(),
    },
}));

vi.mock( "@/services/audio/module-router", () => ({
    applyRouting: vi.fn(),
}));

vi.mock( "@/utils/resource-manager", () => ({
    blobToResource: mocks.blobToResource,
    disposeResource: mocks.disposeResource,
}));

vi.mock( "@/utils/file-util", async importOriginal => ({
    ...( await importOriginal() as object ),
    saveAsFile: mocks.saveAsFile,
}));

vi.mock( "@/workers/sequencer.worker?worker&inline", () => ({
    default: function () {
        return { postMessage: vi.fn() };
    },
}));

import AudioService, { togglePlayback, isRecording } from "@/services/audio-service";
import WaveTables from "@/services/audio/wave-tables";
import SongFactory from "@/model/factories/song-factory";
import { createSongState } from "@/store/modules/song-module";
import { createMockStore } from "../mocks";

/**
 * Mock implementing the OutputRecorder contract: record() starts a fresh capture,
 * export() returns whether an export was triggered and isExporting() reports
 * whether an export is still in flight (until completeExport() is called).
 */
class MockOutputRecorder {
    static instances: MockOutputRecorder[] = [];

    callback: ( blob: Blob ) => void;
    exporting = false;
    exportResult = true;
    disposed = false;
    record = vi.fn();
    stop = vi.fn();
    dispose = vi.fn(() => {
        this.disposed = true;
    });
    export = vi.fn(() => {
        if ( !this.exportResult ) {
            return false;
        }
        this.exporting = true;
        return true;
    });

    constructor( _source: unknown, { callback }: { callback: ( blob: Blob ) => void }) {
        this.callback = callback;
        MockOutputRecorder.instances.push( this );
    }

    isExporting(): boolean {
        return this.exporting;
    }

    completeExport( blob = new Blob([ new Uint8Array( 100 )], { type: "audio/wav" })): void {
        this.exporting = false;
        this.callback( blob );
    }
}

describe( "AudioService output recording lifecycle", () => {
    const store = createMockStore({ song: createSongState({ activeSong: SongFactory.create() }) });

    beforeAll( async () => {
        await AudioService.init( store, WaveTables, MockOutputRecorder as never );
    });

    beforeEach(() => {
        MockOutputRecorder.instances = [];
        vi.clearAllMocks();
    });

    afterEach(() => {
        // flush any dangling recording state so tests remain independent
        if ( isRecording()) {
            AudioService.toggleRecordingState();
        }
        const last = MockOutputRecorder.instances.at( -1 );
        if ( last?.exporting ) {
            last.completeExport();
        }
        togglePlayback( false );
    });

    it( "should record a full session, export once on playback stop and reset state on completion", () => {
        AudioService.toggleRecordingState();

        expect( isRecording()).toBe( true );
        expect( MockOutputRecorder.instances ).toHaveLength( 1 );

        const recorder = MockOutputRecorder.instances[ 0 ];
        expect( recorder.record ).not.toHaveBeenCalled(); // not playing yet

        togglePlayback( true );
        expect( recorder.record ).toHaveBeenCalledTimes( 1 );

        togglePlayback( false );
        expect( recorder.stop ).toHaveBeenCalledTimes( 1 );
        expect( recorder.export ).toHaveBeenCalledTimes( 1 );
        expect( isRecording()).toBe( true ); // still recording until export completes

        recorder.completeExport();

        expect( mocks.saveAsFile ).toHaveBeenCalledTimes( 1 );
        expect( recorder.dispose ).toHaveBeenCalledTimes( 1 );
        expect( isRecording()).toBe( false );
        expect( store.commit ).toHaveBeenCalledWith( "showNotification", expect.anything());
    });

    it( "should not create a second recorder or duplicate the export on repeated stop/play during export", () => {
        AudioService.toggleRecordingState();
        togglePlayback( true );

        const recorder = MockOutputRecorder.instances[ 0 ];

        togglePlayback( false ); // export now in flight
        togglePlayback( false ); // repeated stop
        togglePlayback( true );  // play again while export is in flight

        expect( MockOutputRecorder.instances ).toHaveLength( 1 );
        expect( recorder.export ).toHaveBeenCalledTimes( 1 );
        expect( recorder.record ).toHaveBeenCalledTimes( 1 );

        // toggling the recording state while exporting is ignored
        AudioService.toggleRecordingState();
        expect( isRecording()).toBe( true );
        expect( MockOutputRecorder.instances ).toHaveLength( 1 );

        recorder.completeExport();
        expect( isRecording()).toBe( false );
        expect( mocks.saveAsFile ).toHaveBeenCalledTimes( 1 );
    });

    it( "should start a fresh recorder for consecutive recording sessions", () => {
        AudioService.toggleRecordingState();
        togglePlayback( true );
        const first = MockOutputRecorder.instances[ 0 ];
        togglePlayback( false );
        first.completeExport();

        expect( first.disposed ).toBe( true );

        // a new recording session can start cleanly
        AudioService.toggleRecordingState();
        expect( MockOutputRecorder.instances ).toHaveLength( 2 );

        const second = MockOutputRecorder.instances[ 1 ];
        togglePlayback( true );
        expect( second.record ).toHaveBeenCalledTimes( 1 );

        togglePlayback( false );
        second.completeExport();
        expect( isRecording()).toBe( false );
    });

    it( "should stop and export when recording is disabled during playback", () => {
        AudioService.toggleRecordingState();
        togglePlayback( true );

        const recorder = MockOutputRecorder.instances[ 0 ];

        AudioService.toggleRecordingState(); // disarm while playing

        expect( recorder.stop ).toHaveBeenCalledTimes( 1 );
        expect( recorder.export ).toHaveBeenCalledTimes( 1 );

        recorder.completeExport();
        expect( isRecording()).toBe( false );
    });

    it( "should free resources without saving a file when nothing was recorded", () => {
        AudioService.toggleRecordingState();
        togglePlayback( true );

        const recorder = MockOutputRecorder.instances[ 0 ];
        recorder.exportResult = false; // no audio was captured

        togglePlayback( false );

        expect( recorder.export ).toHaveBeenCalledTimes( 1 );
        expect( recorder.dispose ).toHaveBeenCalledTimes( 1 );
        expect( isRecording()).toBe( false );
        expect( mocks.saveAsFile ).not.toHaveBeenCalled();
    });

    it( "should do nothing when playback stops without an armed recording", () => {
        expect(() => {
            togglePlayback( true );
            togglePlayback( false );
            togglePlayback( false );
        }).not.toThrow();

        expect( MockOutputRecorder.instances ).toHaveLength( 0 );
        expect( mocks.saveAsFile ).not.toHaveBeenCalled();
        expect( isRecording()).toBe( false );
    });
});
