import RecorderWorker from "@/workers/recorder.worker?worker";

type RecordCallback = ( recordedAudio: Blob ) => void;

/**
 * Adapted from Matt Diamonds recorderjs.
 * Separated from node_modules to allow inlining of worker through Webpack
 * as well as freeing allocated memory to recording.
 */
export default class OutputRecorder
{
    private recording: boolean;
    private exporting: boolean;
    private type: string;
    private callback: RecordCallback;
    private node: ScriptProcessorNode;
    private worker: Worker;

    constructor( source: AudioNode, { type = "audio/wav", bufferSize = 4096, callback }:
        { type?: string, bufferSize?: number, callback: RecordCallback }) {

        const context: BaseAudioContext = source.context;

        this.recording = false;
        this.exporting = false;
        this.type      = type;
        this.callback  = callback;

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
            if ( !this.recording ) {
                return;
            }
            // record all channels provided by the input (e.g. 1 for mono, 2 for stereo)
            const { inputBuffer } = e;
            const buffer: Float32Array[] = [];
            for ( let channel = 0; channel < inputBuffer.numberOfChannels; ++channel ) {
                buffer.push( inputBuffer.getChannelData( channel ));
            }
            this.worker.postMessage({
                command: "record",
                buffer
            });
        };
        source.connect( this.node );
        this.node.connect( context.destination ); // this should not be necessary
    }

    record(): void {
        this.recording = true;
    }

    stop(): void {
        this.recording = false;
    }

    dispose(): void {
        this.worker?.postMessage({ command: "clear" });
        this.worker?.terminate();
        this.worker = null;
    }

    export( type?: string ): void {
        if ( this.exporting || !this.worker ) {
            // an export is already pending (or the recorder has been disposed),
            // ignore to prevent generating duplicate files for a single recording
            return;
        }
        this.exporting = true;
        this.worker.postMessage({
            command: "exportWAV",
            type: type || this.type
        });
    }
}
