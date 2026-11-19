import { describe, it, expect, beforeEach, vi } from "vitest";
import OutputRecorder from "@/services/audio/output-recorder";

const mockWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as (( e: MessageEvent ) => void ) | null,
};

vi.mock( "@/workers/recorder.worker?worker", () => ({
    default: function () {
        return mockWorker;
    },
}));

describe( "OutputRecorder", () => {
    let mockNode: {
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        onaudioprocess: (( e: unknown ) => void ) | null;
    };
    let mockSource: {
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        context: {
            sampleRate: number;
            destination: unknown;
            createScriptProcessor: ReturnType<typeof vi.fn>;
        };
    };

    const createRecorder = ( callback = vi.fn()) =>
        new OutputRecorder( mockSource as never, { callback });

    const postedCommands = (): string[] =>
        mockWorker.postMessage.mock.calls.map(([ message ]) => message.command );

    const fireAudioProcess = ( frames = 8 ): void => {
        mockNode.onaudioprocess?.({
            inputBuffer: {
                getChannelData: () => new Float32Array( frames ),
            },
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockWorker.onmessage = null;
        mockNode = {
            connect: vi.fn(),
            disconnect: vi.fn(),
            onaudioprocess: null,
        };
        mockSource = {
            connect: vi.fn(),
            disconnect: vi.fn(),
            context: {
                sampleRate: 44100,
                destination: {},
                createScriptProcessor: vi.fn(() => mockNode ),
            },
        };
    });

    it( "should initialise the worker with the context sample rate and connect the nodes", () => {
        createRecorder();

        expect( mockWorker.postMessage ).toHaveBeenCalledWith({
            command: "init",
            config: { sampleRate: 44100 },
        });
        expect( mockSource.connect ).toHaveBeenCalledWith( mockNode );
        expect( mockNode.connect ).toHaveBeenCalledWith( mockSource.context.destination );
    });

    it( "should clear the previous buffer when starting a new recording", () => {
        const recorder = createRecorder();

        recorder.record();

        expect( postedCommands()).toContain( "clear" );
        expect( recorder.isRecording()).toBe( true );
    });

    it( "should forward audio chunks to the worker while recording and stop forwarding after stop()", () => {
        const recorder = createRecorder();

        // chunks arriving before record() should not be forwarded
        fireAudioProcess();
        expect( postedCommands()).not.toContain( "record" );

        recorder.record();
        fireAudioProcess();
        fireAudioProcess();

        const recordCalls = mockWorker.postMessage.mock.calls.filter(([ msg ]) => msg.command === "record" );
        expect( recordCalls ).toHaveLength( 2 );
        expect( recordCalls[ 0 ][ 0 ].buffer ).toHaveLength( 2 ); // stereo

        recorder.stop();
        expect( recorder.isRecording()).toBe( false );

        fireAudioProcess();
        expect( mockWorker.postMessage.mock.calls.filter(([ msg ]) => msg.command === "record" )).toHaveLength( 2 );
    });

    it( "should treat repeated stop() calls as a no-op", () => {
        const recorder = createRecorder();
        recorder.record();
        fireAudioProcess();

        expect(() => {
            recorder.stop();
            recorder.stop();
            recorder.stop();
        }).not.toThrow();
        expect( postedCommands().filter( cmd => cmd === "record" )).toHaveLength( 1 );
    });

    it( "should not export when nothing was recorded (no empty files)", () => {
        const recorder = createRecorder();

        expect( recorder.export()).toBe( false );
        expect( postedCommands()).not.toContain( "exportWAV" );
        expect( recorder.isExporting()).toBe( false );
    });

    it( "should not export when recording started but no audio was captured", () => {
        const recorder = createRecorder();
        recorder.record();
        recorder.stop();

        expect( recorder.export()).toBe( false );
        expect( postedCommands()).not.toContain( "exportWAV" );
    });

    it( "should export the recorded audio exactly once and invoke the callback on completion", () => {
        const callback = vi.fn();
        const recorder = createRecorder( callback );

        recorder.record();
        fireAudioProcess();
        recorder.stop();

        expect( recorder.export()).toBe( true );
        expect( recorder.isExporting()).toBe( true );
        expect( postedCommands().filter( cmd => cmd === "exportWAV" )).toHaveLength( 1 );

        // repeated exports while in flight are ignored
        expect( recorder.export()).toBe( false );
        expect( postedCommands().filter( cmd => cmd === "exportWAV" )).toHaveLength( 1 );

        // simulate the worker responding with the encoded audio
        const blob = new Blob([ new Uint8Array( 100 )], { type: "audio/wav" });
        mockWorker.onmessage?.({ data: blob } as MessageEvent );

        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( blob );
        expect( recorder.isExporting()).toBe( false );
    });

    it( "should not forward audio chunks received while an export is in flight", () => {
        const recorder = createRecorder();

        recorder.record();
        fireAudioProcess();
        recorder.stop();
        recorder.export();

        fireAudioProcess();

        expect( postedCommands().filter( cmd => cmd === "record" )).toHaveLength( 1 );
    });

    it( "should ignore record() while an export is in flight", () => {
        const recorder = createRecorder();

        recorder.record();
        fireAudioProcess();
        recorder.stop();
        recorder.export();

        const clearsBefore = postedCommands().filter( cmd => cmd === "clear" ).length;
        recorder.record();

        expect( recorder.isRecording()).toBe( false );
        expect( postedCommands().filter( cmd => cmd === "clear" )).toHaveLength( clearsBefore );

        fireAudioProcess();
        expect( postedCommands().filter( cmd => cmd === "record" )).toHaveLength( 1 );
    });

    it( "should terminate the worker and disconnect the node on dispose(), which is idempotent", () => {
        const recorder = createRecorder();
        recorder.record();
        fireAudioProcess();

        recorder.dispose();

        expect( mockWorker.terminate ).toHaveBeenCalledTimes( 1 );
        expect( mockNode.disconnect ).toHaveBeenCalled();
        expect( mockSource.disconnect ).toHaveBeenCalledWith( mockNode );

        expect(() => {
            recorder.dispose();
            recorder.record();
            recorder.stop();
        }).not.toThrow();

        expect( mockWorker.terminate ).toHaveBeenCalledTimes( 1 );
        expect( recorder.export()).toBe( false );
        expect( postedCommands()).not.toContain( "exportWAV" );
    });
});
