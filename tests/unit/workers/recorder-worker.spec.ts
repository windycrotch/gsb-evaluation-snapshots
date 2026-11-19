import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import "@/workers/recorder.worker";

const postMessageSpy = vi.fn();
const originalPostMessage = self.postMessage;

const sendCommand = ( data: unknown ): void => {
    self.dispatchEvent( new MessageEvent( "message", { data }));
};

const recordChunk = ( frames = 4 ): void => {
    sendCommand({
        command: "record",
        buffer: [ new Float32Array( frames ), new Float32Array( frames )],
    });
};

describe( "recorder.worker", () => {

    beforeAll(() => {
        self.postMessage = postMessageSpy;
    });

    afterAll(() => {
        self.postMessage = originalPostMessage;
    });

    beforeEach(() => {
        postMessageSpy.mockClear();
        // reset worker state to a clean recording session
        sendCommand({ command: "init", config: { sampleRate: 44100 } });
    });

    it( "should ignore unknown commands without throwing", () => {
        expect(() => {
            sendCommand({ command: "frobnicate" });
            sendCommand({ command: undefined });
            sendCommand({});
            sendCommand( null );
        }).not.toThrow();
        expect( postMessageSpy ).not.toHaveBeenCalled();
    });

    it( "should ignore malformed record commands without throwing", () => {
        expect(() => {
            sendCommand({ command: "record" });
            sendCommand({ command: "record", buffer: [] });
        }).not.toThrow();
        expect( postMessageSpy ).not.toHaveBeenCalled();
    });

    it( "should export recorded audio as a WAV encoded Blob", () => {
        recordChunk( 4 );
        recordChunk( 4 );

        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).toHaveBeenCalledTimes( 1 );
        const blob = postMessageSpy.mock.calls[ 0 ][ 0 ] as Blob;
        expect( blob ).toBeInstanceOf( Blob );
        expect( blob.type ).toBe( "audio/wav" );
        // 44 byte WAV header + 8 frames * 2 channels * 2 bytes per sample
        expect( blob.size ).toBe( 44 + 8 * 2 * 2 );
    });

    it( "should not emit an empty file when exporting without recorded audio", () => {
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).not.toHaveBeenCalled();
    });

    it( "should not re-export the same audio on repeated export commands", () => {
        recordChunk( 4 );

        sendCommand({ command: "exportWAV", type: "audio/wav" });
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).toHaveBeenCalledTimes( 1 );
    });

    it( "should ignore audio chunks received after an export until a new session starts", () => {
        recordChunk( 4 );
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        // late arriving chunks should not be written into the cleared buffers
        recordChunk( 4 );
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).toHaveBeenCalledTimes( 1 );

        // a new recording session (signalled by "clear") accepts input again
        sendCommand({ command: "clear" });
        recordChunk( 4 );
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).toHaveBeenCalledTimes( 2 );
        const blob = postMessageSpy.mock.calls[ 1 ][ 0 ] as Blob;
        expect( blob.size ).toBe( 44 + 4 * 2 * 2 );
    });

    it( "should start with a clean buffer when re-initialised", () => {
        recordChunk( 4 );

        sendCommand({ command: "init", config: { sampleRate: 48000 } });
        sendCommand({ command: "exportWAV", type: "audio/wav" });

        expect( postMessageSpy ).not.toHaveBeenCalled();
    });
});
