/**
 * Minimal Web Audio API mock used to test the AudioService without a real AudioContext.
 *
 * The mock provides just enough behaviour to assert on node creation, parameter
 * scheduling and playback lifecycle (start/stop/onended).
 */

export class MockAudioParam
{
    public value: number;
    public scheduled: { type: string, value: number, time: number }[] = [];
    public cancelCalls: number[] = [];

    constructor( value = 0 ) {
        this.value = value;
    }

    setValueAtTime( value: number, time: number ): this {
        this.value = value;
        this.scheduled.push({ type: "set", value, time });
        return this;
    }

    linearRampToValueAtTime( value: number, time: number ): this {
        this.value = value;
        this.scheduled.push({ type: "linear", value, time });
        return this;
    }

    exponentialRampToValueAtTime( value: number, time: number ): this {
        this.value = value;
        this.scheduled.push({ type: "exponential", value, time });
        return this;
    }

    cancelScheduledValues( time: number ): this {
        this.cancelCalls.push( time );
        this.scheduled = this.scheduled.filter( entry => entry.time < time );
        return this;
    }
}

export class MockAudioNode
{
    public context: any;
    public connections: any[] = [];
    public disconnectCalls = 0;

    constructor( context?: any ) {
        this.context = context;
    }

    connect( destination: any, _output?: number, _input?: number ): any {
        this.connections.push( destination );
        return destination;
    }

    disconnect(): void {
        ++this.disconnectCalls;
        this.connections.length = 0;
    }
}

export class GainNode extends MockAudioNode
{
    public gain: MockAudioParam;

    constructor( context?: any, value = 1 ) {
        super( context );
        this.gain = new MockAudioParam( value );
    }
}

export class MockOscillatorNode extends MockAudioNode
{
    public frequency = new MockAudioParam( 440 );
    public detune = new MockAudioParam( 0 );
    public type = "sine";
    public periodicWave: any = null;
    public started = false;
    public stopped = false;
    public startTime: number | undefined;
    public stopTime: number | undefined;
    public onended: (() => void) | null = null;

    setPeriodicWave( wave: any ): void {
        this.periodicWave = wave;
    }

    start( time: number ): void {
        this.started = true;
        this.startTime = time;
    }

    stop( time: number ): void {
        this.stopped = true;
        this.stopTime = time;
    }

    // deprecated API names (used when the environment has no AudioContext in window)
    noteOn( time: number ): void {
        this.start( time );
    }

    noteOff( time: number ): void {
        this.stop( time );
    }

    /**
     * simulate the generator reaching the end of its playback
     */
    finish(): void {
        this.onended?.();
    }
}

export class MockAudioBufferSourceNode extends MockAudioNode
{
    public playbackRate = new MockAudioParam( 1 );
    public detune = new MockAudioParam( 0 );
    public buffer: any = null;
    public loop = false;
    public started = false;
    public stopped = false;
    public startTime: number | undefined;
    public stopTime: number | undefined;
    public onended: (() => void) | null = null;

    start( time: number ): void {
        this.started = true;
        this.startTime = time;
    }

    stop( time: number ): void {
        this.stopped = true;
        this.stopTime = time;
    }

    // deprecated API names (used when the environment has no AudioContext in window)
    noteOn( time: number ): void {
        this.start( time );
    }

    noteOff( time: number ): void {
        this.stop( time );
    }

    finish(): void {
        this.onended?.();
    }
}

export class MockBiquadFilterNode extends MockAudioNode
{
    public frequency = new MockAudioParam( 350 );
    public Q = new MockAudioParam( 1 );
    public gain = new MockAudioParam( 0 );
    public detune = new MockAudioParam( 0 );
    public type = "lowpass";
}

export class MockDelayNode extends MockAudioNode
{
    public delayTime = new MockAudioParam( 0 );
}

export class MockStereoPannerNode extends MockAudioNode
{
    public pan = new MockAudioParam( 0 );
}

export class MockWaveShaperNode extends MockAudioNode
{
    public curve: Float32Array | null = null;
    public oversample = "none";
}

export class MockPeriodicWave
{
}

export class MockAudioBuffer
{
    constructor( public numberOfChannels: number, public length: number, public sampleRate: number ) {
    }

    get duration(): number {
        return this.length / this.sampleRate;
    }

    getChannelData( _channel: number ): Float32Array {
        return new Float32Array( this.length );
    }
}

export class MockScriptProcessorNode extends MockAudioNode
{
    public onaudioprocess: (( event: any ) => void ) | null = null;
}

export const createMockAudioContext = (): any => {    const context: any = {
        sampleRate: 44100,
        currentTime: 0,
        state: "running",
        destination: null,

        createGain: () => new GainNode( context ),
        createGainNode: () => new GainNode( context ),
        createOscillator: () => new MockOscillatorNode( context ),
        createBufferSource: () => new MockAudioBufferSourceNode( context ),
        createBiquadFilter: () => new MockBiquadFilterNode( context ),
        createDelay: () => new MockDelayNode( context ),
        createStereoPanner: () => new MockStereoPannerNode( context ),
        createWaveShaper: () => new MockWaveShaperNode( context ),
        createAnalyser: () => new MockAudioNode( context ),
        createDynamicsCompressor: () => new MockAudioNode( context ),
        createChannelSplitter: () => new MockAudioNode( context ),
        createChannelMerger: () => new MockAudioNode( context ),
        createPeriodicWave: () => new MockPeriodicWave(),
        createBuffer: ( channels: number, length: number, sampleRate: number ) => new MockAudioBuffer( channels, length, sampleRate ),
        createScriptProcessor: () => new MockScriptProcessorNode( context ),
        createJavaScriptNode: () => new MockScriptProcessorNode( context ),
    };
    context.destination = new MockAudioNode( context );
    return context;
};
