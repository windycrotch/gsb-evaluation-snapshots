import RecorderWorker from "@/workers/recorder.worker?worker";

type RecordCallback = ( recordedAudio: Blob ) => void;

/**
 * Adapted from Matt Diamonds recorderjs.
 * Separated from node_modules to allow inlining of worker through Webpack
 * as well as freeing allocated memory to recording.
 *
 * Lifecycle: record() starts a fresh capture (clearing previously recorded
 * buffers), stop() halts the capture, export() requests the recorded audio
 * exactly once (only when audio was actually captured) and dispose() releases
 * the worker and disconnects the processor node.
 */
export default class OutputRecorder
{
    private recording: boolean;
    private exporting: boolean;
    private capturedChunks: number;
    private type: string;
    private callback: RecordCallback;
    private source: AudioNode;
    private node: ScriptProcessorNode;
    private worker: Worker;

    constructor( source: AudioNode, { type = "audio/wav", bufferSize = 4096, callback }:
        { type?: string, bufferSize?: number, callback: RecordCallback }) {

        const context: BaseAudioContext = source.context;

        this.recording      = false;
        this.exporting      = false;
        this.capturedChunks = 0;
        this.type           = type;
        this.callback       = callback;
        this.source         = source;

        // @ts-expect-error Property 'createJavaScriptNode' does not exist on type 'AudioContext'
        this.node = ( context.createScriptProcessor || context.createJavaScriptNode ).call( context, bufferSize, 2, 2 );

        this.worker = new RecorderWorker();
        this.worker.onmessage = ( e: MessageEvent ): void => {
            this.exporting = false;
            this.callback?.( e.data );
        };

        this.worker.postMessage({
            command: "init",
            config: {
                sampleRate: context.sampleRate
            }
        });

        this.node.onaudioprocess = ( e: AudioProcessingEvent ): void => {
            // don't forward audio chunks when not recording or while an
            // export is in progress (the worker has cleared its buffers)
            if ( !this.recording || this.exporting || !this.worker ) {
                return;
            }
            ++this.capturedChunks;
            this.worker.postMessage({
                command: "record",
                buffer: [
                    e.inputBuffer.getChannelData( 0 ),
                    e.inputBuffer.getChannelData( 1 )
                ]
            });
        };
        source.connect( this.node );
        this.node.connect( context.destination ); // this should not be necessary
    }

    /**
     * Start capturing audio. Any previously recorded buffer is cleared so
     * audio from an earlier session never leaks into the new recording.
     */
    record(): void {
        if ( this.exporting || !this.worker ) {
            return; // cannot (re)start while a previous export is in flight or after disposal
        }
        this.worker.postMessage({ command: "clear" });
        this.capturedChunks = 0;
        this.recording      = true;
    }

    stop(): void {
        this.recording = false;
    }

    isRecording(): boolean {
        return this.recording;
    }

    isExporting(): boolean {
        return this.exporting;
    }

    /**
     * Request the recorded audio. Returns whether an export was actually
     * triggered: when no audio was captured, nothing is exported (this
     * prevents emitting empty files) and repeat invocations while an export
     * is in flight are ignored (preventing duplicate exports).
     */
    export( type?: string ): boolean {
        if ( this.exporting || !this.worker || this.capturedChunks === 0 ) {
            return false;
        }
        this.recording = false;
        this.exporting = true;
        this.worker.postMessage({
            command: "exportWAV",
            type: type || this.type
        });
        return true;
    }

    /**
     * Free all resources held by this recorder. Is idempotent and renders
     * the recorder inert (subsequent record/stop/export calls are no-ops).
     */
    dispose(): void {
        this.recording = false;
        if ( this.worker ) {
            this.worker.postMessage({ command: "clear" });
            this.worker.terminate();
            this.worker = null;
        }
        if ( this.node ) {
            this.node.onaudioprocess = null;
            this.node.disconnect();
            this.source?.disconnect( this.node );
        }
    }
}
