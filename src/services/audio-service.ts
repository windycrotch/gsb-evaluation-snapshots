/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2016-2023 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { Store } from "vuex";
import Config from "@/config";
import { type ModuleParamDef } from "@/definitions/automatable-parameters";
import OscillatorTypes from "@/definitions/oscillator-types";
import ModuleFactory from "@/model/factories/module-factory";
import { ACTION_NOTE_ON } from "@/model/types/audio-event";
import { applyRouting } from "./audio/module-router";
import { applyModuleParamChange, getCurrentValueForParam, cancelScheduledModuleAutomation } from "./audio/module-automation";
import type { ExternalEventCallback } from "./audio/module-automation";
import type OutputRecorder from "./audio/output-recorder";
import type WaveTables from "./audio/wave-tables";
import { getFrequency } from "./audio/pitch";
import { processVoiceLists } from "./audio/audio-util";
import ADSR, { getReleaseTime } from "./audio/adsr-module";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import type { EventVoice, EventVoiceList } from "@/model/types/event-voice";
import type { Instrument, InstrumentOscillator, OscillatorProp } from "@/model/types/instrument";
import type { InstrumentModules, InstrumentVoice, InstrumentVoiceList } from "@/model/types/instrument-modules";
import { PlaybackType } from "@/model/types/sample";
import type { EffluxSong } from "@/model/types/song";
import type { EffluxState } from "@/store";
import type { SampleCacheEntry } from "@/store/modules/sample-module";
import {
    tuneToOscillator, tuneSamplePitch, tuneBufferPlaybackRate, adjustEventWaveForms,
    adjustEventVolume, adjustEventTunings
} from "@/utils/instrument-util";
import { saveAsFile } from "@/utils/file-util";
import {
    init as initAudioContext, startOscillation, stopOscillation, setValue,
    createGainNode, createStereoPanner, createPWM, createWaveTableFromGraph
} from "./audio/webaudio-helper";
import { blobToResource, disposeResource } from "@/utils/resource-manager";
import { getSliceIndexForNote } from "@/utils/sample-util";

/* private properties */

type CustomWaveTableList = PeriodicWave[];

let store: Store<EffluxState>;
let state: EffluxState;
let audioContext: BaseAudioContext;
let eventCallback: ExternalEventCallback | undefined;
let masterBus: AudioNode;
let eq: BiquadFilterNode;
let compressor: DynamicsCompressorNode;
let playing = false;
let recordOutput = false; // whether an output recording session is active (armed, recording or exporting)
let outputRecorderRef: typeof OutputRecorder;
let recorder: OutputRecorder;
let recorderState: "idle" | "recording" | "exporting" = "idle";
let exportWatchdog: ReturnType<typeof setTimeout> | undefined;
let instrumentModulesList: InstrumentModules[]; // holds all modules for each instantiated instrument
let playingEventVoices: Record<number, EventVoiceList>[]; // [instrumentIndex][eventId][eventVoiceIndex]
let activeSong: EffluxSong | undefined; // reference to the song whose model values are currently applied to the modules
// instrument indices whose module parameters were altered by module parameter automation
// during playback. These are restored to the song model values when playback stops.
const instrumentsTouchedByAutomation = new Set<number>();
let pool: {
    NOISE: AudioBuffer,
    CUSTOM: CustomWaveTableList[],
    [ OscillatorTypes.SINE ]: PeriodicWave,
    [ OscillatorTypes.SAW ]: PeriodicWave,
    [ OscillatorTypes.TRIANGLE ]: PeriodicWave,
    [ OscillatorTypes.SQUARE ]: PeriodicWave
};
let UNIQUE_EVENT_ID = 0;

// statistics describing voice pool usage, mainly useful for diagnostics (and tests)

let voiceOverflowCount = 0; // amount of voices that had to be created beyond the pooled amount
const voicePoolExhaustionNotified = new Set<string>(); // instrumentIndex:oscillatorIndex combinations that were reported

const POOL_GAIN_NODES = false; // engine stability test

// safety margin (in seconds) applied to the teardown of a released voice. This ensures
// the release envelope is rendered in full before the voice nodes are disconnected.
const VOICE_TEARDOWN_MARGIN = 0.01;

// maximum amount of time (in milliseconds) to wait for a recording export to complete
// before the recording state is reset (allowing a new recording to be started)
const EXPORT_TIMEOUT_MS = 30_000;

/**
 * Prepares the environment to create pools for oscillators, wave tables and instruments.
 * optExternalEventCallback is an optional callback to invoke for EXTERNAL_EVENT automations
 */
export const prepareEnvironment = ( audioContextInstance: BaseAudioContext,
    waveTables: typeof WaveTables, optExternalEventCallback?: ExternalEventCallback ): void => {

    audioContext  = audioContextInstance;
    eventCallback = optExternalEventCallback;
    setupRouting();

    // reset the recording state, a new environment means a new recorder will be created on demand
    disposeRecorder();

    // initialize the WaveTable / AudioBuffer pool

    // @ts-expect-error pool initializes with one key at a time
    pool = {};
    pool.NOISE = audioContext.createBuffer( 1, audioContext.sampleRate / 10, audioContext.sampleRate ),
    pool.CUSTOM = []; // content created and maintained by "cacheCustomTables()"

    const noiseChannel = pool.NOISE.getChannelData( 0 );
    for ( let i = 0, l = noiseChannel.length; i < l; ++i ) {
        noiseChannel[ i ] = Math.random() * 2 - 1;
    }

    // create periodic waves from the entries in the WaveTables definitions file

    Object.keys( waveTables ).forEach(( waveIdentifier: OscillatorTypes ) => {
        if ( waveIdentifier === OscillatorTypes.SAMPLE ) {
            return;
        }
        // @ts-expect-error not all OscillatorTypes have tables available
        const table = waveTables[ waveIdentifier ];
        // @ts-expect-error 'import.meta' property not allowed, not an issue Vite takes care of it
        if ( import.meta.env.MODE !== "production" ) {
            if ( !table ) {
                throw new Error( `cannot create periodic wave for non-existing table of "${waveIdentifier}"` );
            }
        }
        // @ts-expect-error not all OscillatorTypes have pooled wave tables
        pool[ waveIdentifier ] = audioContext.createPeriodicWave(
            new Float32Array( table.real ),
            new Float32Array( table.imag )
        );
    });
    playingEventVoices = new Array( Config.INSTRUMENT_AMOUNT );
    for ( let i = 0; i < Config.INSTRUMENT_AMOUNT; ++i ) {
        playingEventVoices[ i ] = {} as Record<number, EventVoiceList>;
    }
    activeSong = undefined;
    voiceOverflowCount = 0;
    voicePoolExhaustionNotified.clear();
    instrumentsTouchedByAutomation.clear();
    createModules();
    AudioService.initialized = true;
};

/**
 * halts all playing audio, flushes events and
 * resets unique event id counter when requested (e.g. when loading new song)
 *
 * All voices that are still sounding will have their release envelope applied
 * (if this hadn't happened yet) so their tail is rendered before the voice is
 * returned to the instruments voice pool. This method is safe to invoke
 * repeatedly: already released / returned voices are ignored.
 */
export const reset = ( resetEventCounter = false ): void => {
    if ( !instrumentModulesList ) {
        // environment not prepared, nothing to reset
        if ( resetEventCounter ) {
            UNIQUE_EVENT_ID = 0;
        }
        return;
    }
    const now = audioContext ? audioContext.currentTime : 0;

    playingEventVoices.forEach(( eventList, instrumentIndex ) => {
        const modules = instrumentModulesList[ instrumentIndex ];
        processVoiceLists( Object.values( eventList ) as EventVoiceList[], ( voice: EventVoice, oscillatorIndex: number ) => {
            // voices that were already released keep their scheduled teardown,
            // voices that are still sounding are released now. The voice capacity is
            // returned to the pool immediately so a subsequent playback can use it,
            // while the release tail continues to sound on its own (detached) nodes.
            releaseEventVoice( modules, oscillatorIndex, voice, instrumentIndex, now, true );
            // voices already in their release phase (released by a preceding noteOff) also
            // have their capacity returned right away so the pool is fully restored on stop
            returnVoiceCapacityToPool( modules, oscillatorIndex, voice );
        });
        playingEventVoices[ instrumentIndex ] = {};
    });

    // automation can have altered the audio module parameters during playback,
    // restore these to the values defined by the song model
    restoreModelParameters();

    if ( resetEventCounter ) {
        UNIQUE_EVENT_ID = 0;
    }
};

/**
 * apply the current song models instrument module values onto the audio
 * processing chain (used to undo changes made by module parameter automation)
 */
export const restoreModelParameters = (): void => {
    if ( !instrumentModulesList || !activeSong ) {
        instrumentsTouchedByAutomation.clear();
        return;
    }
    instrumentsTouchedByAutomation.forEach( instrumentIndex => {
        const instrument = activeSong!.instruments[ instrumentIndex ];
        const modules    = instrumentModulesList[ instrumentIndex ];
        if ( !instrument || !modules ) {
            return;
        }
        // discard any (glide) values scheduled by module parameter automation before
        // reapplying the song model values (only automation-touched instruments are
        // affected so UI-set values of other instruments are left untouched)
        cancelScheduledModuleAutomation( modules );

        ModuleFactory.applyConfiguration( "filter",    modules, instrument.filter,    masterBus );
        ModuleFactory.applyConfiguration( "delay",     modules, instrument.delay,     masterBus );
        ModuleFactory.applyConfiguration( "eq",        modules, instrument.eq,        masterBus );
        ModuleFactory.applyConfiguration( "overdrive", modules, instrument.overdrive, masterBus );
        if ( modules.panner ) {
            const panning = instrument.panning ? parseFloat( instrument.panning.toString() ) : 0;
            modules.panner.pan.value = panning;
        }
        modules.output.gain.value = getInstrumentOutputGain( activeSong!, instrument );
    });
    instrumentsTouchedByAutomation.clear();
};

export const togglePlayback = ( setPlaying: boolean ): void => {
    playing = setPlaying;
    if ( playing ) {
        // when a recording session was armed, start capturing. An export that is still
        // in flight belongs to the previous session and is not affected by the restart.
        startRecordingIfArmed();
    } else {
        reset();
        // when a recording session is recording, stopping the playback finalizes
        // the recording and starts its export (an export already in flight is left alone)
        stopAndExportRecording();
    }
};

/**
 * cache the custom WaveTables that are available to the instruments
 */
export const cacheCustomTables = ( instruments: Instrument[]): void => {
    instruments.forEach(( instrument, instrumentIndex ) => {
        pool.CUSTOM[ instrumentIndex ] = new Array( instrument.oscillators.length );
        instrument.oscillators.forEach(( oscillator, oscillatorIndex ) => {
            if ( oscillator.table ) {
                pool.CUSTOM[ instrumentIndex ][ oscillatorIndex ] = createTableFromCustomGraph(
                    instrumentIndex, oscillatorIndex, oscillator.table as number[]
                );
            }
        });
    });
};

/**
 * apply the module settings described in the currently active songs model onto the audio processing chain.
 * note: connectAnalysers specifies whether to connect the analyser nodes to each instrument channels'
 * output, this allows for monitoring audio levels (at the expense of some computational overhead).
 */
export const applyModules = ( song: EffluxSong, connectAnalysers = false ): void => {
    useAnalysers = connectAnalysers;
    if ( !song || !instrumentModulesList ) {
        return;
    }
    // cache a reference so automation changes can be reverted on stop (see reset())
    activeSong = song;

    // first check if one of the channels is configured to operate solo
    song.instruments.forEach(( instrument, instrumentIndex ) => {
        const instrumentModules = instrumentModulesList[ instrumentIndex ];

        instrumentModules.output.gain.value = getInstrumentOutputGain( song, instrument );

        if ( instrumentModules.panner ) {
            const panning = instrument.panning ? parseFloat( instrument.panning.toString() ) : 0;
            instrumentModules.panner.pan.value = panning;
        }
        ModuleFactory.applyConfiguration( "filter",    instrumentModules, instrument.filter,    masterBus );
        ModuleFactory.applyConfiguration( "delay",     instrumentModules, instrument.delay,     masterBus );
        ModuleFactory.applyConfiguration( "eq",        instrumentModules, instrument.eq,        masterBus );
        ModuleFactory.applyConfiguration( "overdrive", instrumentModules, instrument.overdrive, masterBus );
    });
};

/**
 * synthesize the audio for given event at given startTime
 */
export const noteOn = ( event: EffluxAudioEvent, instrument: Instrument,
    sampleCache: Map<string, SampleCacheEntry>, startTimeInSeconds = audioContext.currentTime ): void => {

    if ( event.action === ACTION_NOTE_ON ) {

        // here we create a unique event identifier which is used to store a reference to the
        // event during its playback time.

        // however, first check if the event already has an id and is currently playing back
        // (the scenario here is a pattern jump / sequencer action retriggering an already
        // playing event, for instance: looping a single measure where a new "retrigger" of
        // the event should be played while the first one is still playing back its release tail).

        if ( event.id ) {

            // force noteOff on currently playing nodes (will go to release phase and
            // afterwards dispose of playing nodes).

            noteOff( event, startTimeInSeconds ); // will clear previously playing notes for event
            event.id = null;  // generates a new id below
        }
        if ( !event.id ) {
            event.id = ++UNIQUE_EVENT_ID;
        }

        // console.info(`NOTE ON for ${event.id} (${event.note}${event.octave}) @ ${startTimeInSeconds}s`);

        const frequency = getFrequency( event.note, event.octave );
        const modules   = instrumentModulesList[ instrument.index ];
        const voices    = [] as EventVoiceList;

        let oscillator: InstrumentOscillator;

        instrument.oscillators.forEach(( oscillatorVO, oscillatorIndex ) => {
            if ( !oscillatorVO.enabled ) {
                return;
            }
            oscillator = instrument.oscillators[ oscillatorIndex ];

            // retrieve from pool the envelope gain structure for the oscillator voice
            const { nodes: oscillatorNodes, fromPool } = retrieveAvailableVoiceNodesFromPool( modules, oscillatorIndex );
            const { oscillatorNode, adsrNode } = oscillatorNodes;
            let generatorNode;

            switch ( oscillatorVO.waveform ) {
                default:
                    if ( oscillatorVO.waveform === OscillatorTypes.PWM ) {
                        // PWM uses a custom Oscillator type which connects its structure directly to the oscillatorNode
                        generatorNode = createPWM(
                            audioContext, startTimeInSeconds, startTimeInSeconds + 2, oscillatorNode
                        );
                    } else {
                        // all other waveforms have WaveTables which are defined in the pools
                        generatorNode = audioContext.createOscillator();
                        let table;

                        if ( oscillatorVO.waveform !== OscillatorTypes.CUSTOM ) {
                            table = pool[ oscillatorVO.waveform ];
                        } else {
                            table = pool.CUSTOM[ instrument.index ][ oscillatorIndex ];
                        }
                        if ( !table ) {
                            // no table ? that's a bit of a problem. what did you break!? return the unused nodes
                            returnUnusedVoiceNodesToPool( modules, oscillatorIndex, oscillatorNodes, fromPool );
                            return;
                        }
                        generatorNode.setPeriodicWave( table );
                    }
                    // tune event frequency to oscillator tuning and apply pitch envelopes
                    generatorNode.frequency.value = tuneToOscillator( frequency, oscillator );
                    break;

                case OscillatorTypes.SAMPLE:
                    const cacheEntry: SampleCacheEntry = sampleCache.get( oscillator.sample );
                    if ( !cacheEntry ) {
                        return returnUnusedVoiceNodesToPool( modules, oscillatorIndex, oscillatorNodes, fromPool );
                    }
                    const { sample } = cacheEntry;
                    generatorNode = audioContext.createBufferSource();
                    generatorNode.loop = sample.loop;

                    if ( sample.type === PlaybackType.SLICED ) {
                        const sliceIndex = getSliceIndexForNote( event, sample );
                        if ( cacheEntry.slices[ sliceIndex ] === undefined ) {
                            return returnUnusedVoiceNodesToPool( modules, oscillatorIndex, oscillatorNodes, fromPool );
                        }
                        generatorNode.buffer = cacheEntry.slices[ sliceIndex ];
                    } else {
                        generatorNode.buffer = sample.buffer;
                    }
                    
                    if ( sample.type === PlaybackType.REPITCHED ) {
                        tuneSamplePitch( generatorNode, frequency, sample, oscillator );
                    } else {
                        tuneBufferPlaybackRate( generatorNode, oscillator );
                    }
                    break;

                case OscillatorTypes.NOISE:
                    generatorNode = audioContext.createBufferSource();
                    generatorNode.buffer = pool.NOISE;
                    generatorNode.loop = true;
                    tuneBufferPlaybackRate( generatorNode, oscillator );
                    break;
            }

            // apply envelopes

            setValue( oscillatorNode.gain, oscillatorVO.volume, audioContext );
            setValue( adsrNode.gain, 1, audioContext );

            ADSR.applyAmpEnvelope  ( oscillatorVO, adsrNode,      startTimeInSeconds );
            ADSR.applyPitchEnvelope( oscillatorVO, generatorNode, startTimeInSeconds );

            // route oscillator to track gain > envelope gain > instrument gain

            if ( oscillatorVO.waveform !== OscillatorTypes.PWM ) {
                generatorNode.connect( oscillatorNode );
            }

            voices[ oscillatorIndex ] = /** @type {EventVoice} */ ({
                frequency,
                generator: generatorNode,
                vo: oscillatorVO,
                gain: oscillatorNode,
                outputNode: adsrNode,
                gliding: false,
                eventId: event.id,
                released: false,
                returned: false,
                fromPool
            });

            // start playback and attach listener to track playback end
            // (we attach the listener directly instead of inside the noteOff-handler as very short, non-looped
            // AudioBufferSources can finish their playback before the sequencer can request the noteOff)

            attachVoiceTeardown( modules, oscillatorIndex, voices[ oscillatorIndex ], instrument.index, event.id );
            startOscillation( generatorNode, startTimeInSeconds );
        });
        playingEventVoices[ instrument.index ][ event.id ] = voices;
    }
    // module parameter change specified ? process it.

    if ( event.mp ) {
        // track which instruments receive automation so their module values can be
        // restored to the song model values when playback stops
        instrumentsTouchedByAutomation.add( instrument.index );

        applyModuleParamChange(
            audioContext,
            event,
            instrumentModulesList[ instrument.index ],
            instrument,
            Object.values( playingEventVoices[ instrument.index ]) as EventVoiceList[],
            startTimeInSeconds,
            masterBus,
            eventCallback
        );
    }
};

/**
 * immediately stop playing audio for the given event (or after a small
 * delay in case a positive release envelope is set)
 * note: startTimeInSeconds describes the optional time to start the noteOff,  which will default
 * to the current time. This time should equal the end of the note's sustain period as the release
 * envelope will be applied automatically
 */
export const noteOff = ( event: EffluxAudioEvent, startTimeInSeconds = audioContext.currentTime ): void => {
    const eventId   = event.id, instrumentIndex = event.instrument;
    const voiceList = playingEventVoices[ instrumentIndex ]?.[ eventId ];

    if ( !voiceList ) {
        return; // event has no reference to playing nodes
    }
    // console.info(`NOTE OFF for ${event.id} ( ${event.note}${event.octave} @ ${startTimeInSeconds}s`);

    const modules = instrumentModulesList[ instrumentIndex ];

    voiceList.forEach(( voice, oscillatorIndex ) => {
        if ( !voice ) {
            return;
        }
        releaseEventVoice( modules, oscillatorIndex, voice, instrumentIndex, startTimeInSeconds );
    });
};

/**
 * retrieve a reference to the applications AudioContext
 */
export const getAudioContext = (): BaseAudioContext => audioContext;

export const isRecording = (): boolean => recordOutput;

export const getRecordingState = (): "idle" | "recording" | "exporting" => recorderState;

/**
 * retrieve the amount of voices currently playing back per instrument/oscillator,
 * as well as the amount of voices available in each instruments voice pool.
 *
 * This is mainly intended for diagnostics and automated tests (e.g. verifying that
 * all voices are returned to the pool once playback stops).
 */
export const getVoicePoolStats = (): { instrumentIndex: number, oscillatorIndex: number, available: number, playing: number }[] => {
    const stats: { instrumentIndex: number, oscillatorIndex: number, available: number, playing: number }[] = [];
    if ( !instrumentModulesList ) {
        return stats;
    }
    const playingPerInstrument: number[][] = instrumentModulesList.map(() => new Array( Config.OSCILLATOR_AMOUNT ).fill( 0 ));

    playingEventVoices.forEach(( eventList, instrumentIndex ) => {
        processVoiceLists( Object.values( eventList ) as EventVoiceList[], ( _voice: EventVoice, oscillatorIndex: number ) => {
            if ( playingPerInstrument[ instrumentIndex ]) {
                ++playingPerInstrument[ instrumentIndex ][ oscillatorIndex ];
            }
        });
    });

    instrumentModulesList.forEach(( modules, instrumentIndex ) => {
        modules.voices.forEach(( voiceList, oscillatorIndex ) => {
            stats.push({
                instrumentIndex,
                oscillatorIndex,
                available: voiceList.length,
                playing: playingPerInstrument[ instrumentIndex ]?.[ oscillatorIndex ] ?? 0
            });
        });
    });
    return stats;
};

/**
 * retrieve the amount of voices that had to be synthesized beyond the (pooled) capacity
 * since the environment was prepared. A value above zero indicates voice pool exhaustion occurred.
 */
export const getVoiceOverflowCount = (): number => voiceOverflowCount;

/**
 * retrieve the events currently playing back per instrument (indexed by event id).
 * This exposes the node references of each voice, mainly intended for diagnostics and tests.
 */
export const getPlayingEventVoices = (): Record<number, EventVoiceList>[] => playingEventVoices;

let useAnalysers = false;
export const connectAnalysers = (): boolean => useAnalysers;

export const getCurrentModuleParamValue = ( instrument: Instrument, param: ModuleParamDef ): number => getCurrentValueForParam( instrumentModulesList[ instrument.index ], instrument, param );

/**
 * retrieve a reference to the audio processing modules of given instrument (mainly for diagnostics)
 */
export const getInstrumentModules = ( instrumentIndex: number ): InstrumentModules | undefined => instrumentModulesList?.[ instrumentIndex ];

/**
 * assign the store instance used to publish notifications. The application assigns this
 * through init(), this method additionally allows services that do not use the Vuex store
 * (e.g. the Tiny player, or automated tests) to receive notifications.
 */
export const setStore = ( storeReference: Store<EffluxState> ): void => {
    store = storeReference;
    state = storeReference?.state;
};

/**
 * override the output recorder class (e.g. for environments that supply a custom recorder).
 * note: an active recorder session is released when the reference changes.
 */
export const setOutputRecorderClass = ( recorderReference: typeof OutputRecorder | undefined ): void => {
    disposeRecorder();
    outputRecorderRef = recorderReference;
};

const AudioService =
{
    initialized: false,
    prepareEnvironment,
    reset,
    restoreModelParameters,
    togglePlayback,
    cacheCustomTables,
    applyModules,
    getAudioContext,
    getInstrumentModules,
    isRecording,
    getRecordingState,
    getVoicePoolStats,
    getVoiceOverflowCount,
    getPlayingEventVoices,
    setStore,
    configureOutputRecorder: setOutputRecorderClass,
    noteOn,
    noteOff,

    /**
     * query whether we can actually use the WebAudio API in
     * the current application environment
     */
    isSupported(): boolean {
        // @ts-expect-error vendor prefix not recognized as valid type
        return ( typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined" );
    },
    /**
     * initializes the audioContext so we can synthesize audio using the WebAudio API
     * note: outputRecorderReference is a reference to the output recorder class
     * (should only be passed in case output recording is supported)
     */
    async init( storeReference: Store<EffluxState>, waveTables: typeof WaveTables, outputRecorderReference: typeof OutputRecorder ): Promise<void> {
        store = storeReference;
        state = store.state;

        outputRecorderRef = outputRecorderReference;

        // NOTE: the audioContext is generated asynchronously after a user interaction
        // (e.g. click/touch/keydown anywhere in the document) as browsers otherwise prevent audio playback

        audioContext = await initAudioContext();
        prepareEnvironment( audioContext, waveTables );

        AudioService.cacheCustomTables( state.song.activeSong.instruments );
    },
    toggleRecordingState(): void {
        if ( recordOutput ) {
            // a recording session is active (armed, recording or exporting). When an export is
            // already in flight, stopping is a no-op (the completion handler releases resources).
            if ( recorderState !== "exporting" ) {
                stopAndExportRecording();
            }
            return;
        }
        recordOutput = true;

        if ( !outputRecorderRef ) {
            return; // environment does not support output recording
        }
        if ( !recorder ) {
            recorder = new ( outputRecorderRef )( compressor, {
                callback : handleRecordingComplete
            });
            recorderState = "idle";
        }
        if ( playing ) {
            startRecording();
        }
        // when not playing, the recording is "armed": it will start on the next playback
    },
    cacheAllOscillators( instrumentIndex: number, instrument: Instrument ): void {
        instrument.oscillators.forEach(( oscillator, oscillatorIndex ) => {
            AudioService.updateOscillator( "waveform", instrumentIndex, oscillatorIndex, oscillator );
        });
    },
    updateOscillator( property: OscillatorProp | "tuning", instrumentIndex: number, oscillatorIndex: number, oscillator: InstrumentOscillator ): void {
        // @ts-expect-error 'import.meta' property not allowed, not an issue Vite takes care of it
        if ( import.meta.env.MODE !== "production" ) {
            if ( !/waveform|tuning|volume/.test( property.toString() )) {
                throw new Error(`cannot update unsupported oscillator property ${property.toString()}`);
            }
        }
        const events = Object.values( playingEventVoices[ instrumentIndex ]) as EventVoiceList[];
        switch ( property ) {
            case "waveform":
                if ( oscillator.enabled && oscillator.waveform === OscillatorTypes.CUSTOM ) {
                    adjustEventWaveForms( events, oscillatorIndex,
                        createTableFromCustomGraph( instrumentIndex, oscillatorIndex, oscillator.table as number[] )
                    );
                } else {
                    // @ts-expect-error cannot use string to index pool type
                    adjustEventWaveForms( events, oscillatorIndex, pool[ oscillator.waveform ] );
                }
                break;
            case "volume":
                adjustEventVolume( events, oscillatorIndex, oscillator );
                break;
            case "tuning":
                adjustEventTunings( events, oscillatorIndex, oscillator );
                break;
        }
    },
    adjustInstrumentVolume( instrumentIndex: number, volume: number ): void {
        instrumentModulesList[ instrumentIndex ].output.gain.value = volume;
    },
    adjustInstrumentPanning( instrumentIndex: number, pan: number ): void {
        instrumentModulesList[ instrumentIndex ].panner.pan.value = pan;
    }
};
export default AudioService;

export const getAnalysers = (): AnalyserNode[] => {
    return ( Array.isArray( instrumentModulesList ) ? instrumentModulesList : [] )
                .map( modules => modules.analyser );
};

export const applyModule = ( type: string, instrumentIndex: number, props: any ): void => {
    ModuleFactory.applyConfiguration( type, instrumentModulesList[ instrumentIndex ], props, masterBus );
};

/* internal methods */

/**
 * retrieve the output gain for given instrument, based on its mute/solo state and volume
 */
function getInstrumentOutputGain( song: EffluxSong, instrument: Instrument ): number {
    const hasSoloChannel = song.instruments.some( candidate => !!candidate.solo );
    return instrument.muted || ( hasSoloChannel && !instrument.solo ) ? 0 : instrument.volume;
}

function setupRouting(): void {
    masterBus  = createGainNode( audioContext );
    eq         = audioContext.createBiquadFilter();
    eq.type    = "highpass";
    eq.frequency.value = 30; // remove sub-30 Hz rumbling
    compressor = audioContext.createDynamicsCompressor();
    masterBus.connect( eq );
    eq.connect( compressor );
    compressor.connect( audioContext.destination );
}

function createModules(): void {
    // create new modules for each possible instrument
    instrumentModulesList = new Array( Config.INSTRUMENT_AMOUNT );

    for ( let i = 0; i < instrumentModulesList.length; ++i ) {
        const instrumentModules = instrumentModulesList[ i ] = {
            panner    : createStereoPanner( audioContext ),
            overdrive : ModuleFactory.createOverdrive( audioContext ),
            eq        : ModuleFactory.createEQ( audioContext ),
            filter    : ModuleFactory.createFilter( audioContext ),
            delay     : ModuleFactory.createDelay( audioContext ),
            analyser  : audioContext.createAnalyser(),
            voices    : new Array( Config.OSCILLATOR_AMOUNT ),
            output    : createGainNode( audioContext )
        };
        // max polyphony is 3 oscillators per channel
        for ( let j = 0; j < Config.OSCILLATOR_AMOUNT; ++j ) {
            instrumentModules.voices[ j ] = [];
            // the channel amount can equal the total amount of instruments as in Efflux, each instrument gets a
            // channel strip in the tracker and each channel can override its target instrument (thus 24 simultaneous
            // voices per instrument can be used) we then multiply this as creative usages (black midi??) can
            // allow multiple channels to target the same voice at fast repeating (yet sustaining) intervals
            const mult = 2;
            for ( let k = 0; k < Config.INSTRUMENT_AMOUNT * mult; ++k ) {
                instrumentModules.voices[ j ].push( createVoiceGainStructure( instrumentModules.output ));
            }
        }
        applyRouting( instrumentModules, masterBus );
    }
}

/**
 * retrieve an available gain structure from the pool. When the pool is exhausted an additional
 * gain structure is synthesized (see reportVoicePoolExhaustion). fromPool indicates whether the
 * structure originated from the pool (and should be returned to it once playback has ended).
 */
function retrieveAvailableVoiceNodesFromPool( instrumentModules: InstrumentModules, oscillatorIndex: number ): { nodes: InstrumentVoice, fromPool: boolean } {
    const availableVoices: InstrumentVoiceList = instrumentModules.voices[ oscillatorIndex ];
    if ( availableVoices.length ) {
        return { nodes: availableVoices.shift(), fromPool: true };
    }
    // the pool is exhausted (this happens when many voices are simultaneously in their release phase,
    // e.g. long release envelopes with rapidly retriggered notes). We must not silently drop the note:
    // synthesize an additional voice so playback continues, and report the degradation.
    reportVoicePoolExhaustion( instrumentModules, oscillatorIndex );
    return { nodes: createVoiceGainStructure( instrumentModules.output ), fromPool: false };
}

/**
 * report that a voice pool ran out of available voices. The degradation is observable
 * through the console, a UI notification (only once per oscillator) and getVoicePoolStats()
 */
function reportVoicePoolExhaustion( instrumentModules: InstrumentModules, oscillatorIndex: number ): void {
    ++voiceOverflowCount;

    const instrumentIndex = instrumentModulesList.indexOf( instrumentModules );
    const key = `${instrumentIndex}:${oscillatorIndex}`;

    if ( voicePoolExhaustionNotified.has( key )) {
        return;
    }
    voicePoolExhaustionNotified.add( key );

    console.warn(
        `voice pool exhausted for oscillator ${oscillatorIndex} of instrument ${instrumentIndex}, ` +
        `synthesizing additional voices (voices in release phase will be returned to the pool once finished)`
    );
    try {
        store?.commit?.( "showNotification", {
            message: store.getters?.t
                ? store.getters.t( "messages.voicePoolExhausted", { instrument: instrumentIndex + 1 })
                : `Instrument ${instrumentIndex + 1} ran out of voices, extra voices were allocated to keep notes sounding`
        });
    } catch {
        // notifications are best-effort (e.g. when running headless)
    }
}

function returnUnusedVoiceNodesToPool( instrumentModules: InstrumentModules, oscillatorIndex: number,
    voice: InstrumentVoice, fromPool = true ): void {
    // only pooled structures are returned, synthesized overflow structures are discarded
    if ( fromPool ) {
        instrumentModules.voices[ oscillatorIndex ].push( voice );
    }
}

/**
 * attach a listener to the voice's generator node that disposes the voice
 * once the generator has finished playback.
 *
 * The listener is attached at noteOn time (instead of inside noteOff) as very short, non-looped
 * AudioBufferSources can finish their playback before the sequencer can request the noteOff.
 */
function attachVoiceTeardown( instrumentModules: InstrumentModules, oscillatorIndex: number,
    eventVoice: EventVoice, instrumentIndex: number, eventId: number = -1 ): void {
    eventVoice.generator.onended = (): void => {
        disposeVoice( instrumentModules, oscillatorIndex, eventVoice, instrumentIndex, eventId );
    };
}

/**
 * apply the release envelope onto given voice and schedule the generator to stop
 * after the release has completed. Invoking this repeatedly for the same voice is a no-op.
 *
 * @param returnImmediately when true, the voice capacity is returned to the instruments pool
 *        without waiting for the release tail to finish (used when playback is halted so that
 *        a subsequent playback can acquire the voice again right away). The release tail
 *        continues to sound on the detached nodes.
 */
function releaseEventVoice( instrumentModules: InstrumentModules, oscillatorIndex: number,
    eventVoice: EventVoice, instrumentIndex: number, startTimeInSeconds: number, returnImmediately = false ): void {
    if ( !eventVoice || eventVoice.released ) {
        return;
    }
    eventVoice.released = true;

    // apply release envelopes
    ADSR.applyAmpRelease  ( eventVoice.vo, eventVoice.outputNode, startTimeInSeconds );
    ADSR.applyPitchRelease( eventVoice.vo, eventVoice.generator,  startTimeInSeconds );

    const releaseTime = getReleaseTime( eventVoice.vo );

    stopOscillation( eventVoice.generator, startTimeInSeconds + releaseTime + VOICE_TEARDOWN_MARGIN );

    if ( returnImmediately ) {
        // release the capacity back into the pool right away (idempotent)
        returnVoiceCapacityToPool( instrumentModules, oscillatorIndex, eventVoice );
    }

    // onended will fire when the generator stops, disposing the voice nodes.
    // In case the environment does not invoke onended (or the generator had already ended
    // prior to this release being applied) schedule a timed fallback so the nodes are never leaked.
    scheduleVoiceDisposalFallback( instrumentModules, oscillatorIndex, eventVoice, instrumentIndex,
        startTimeInSeconds, releaseTime + VOICE_TEARDOWN_MARGIN );
}

function scheduleVoiceDisposalFallback( instrumentModules: InstrumentModules, oscillatorIndex: number,
    eventVoice: EventVoice, instrumentIndex: number, startTimeInSeconds: number, delayInSeconds: number ): void {
    if ( typeof window === "undefined" || typeof window.setTimeout !== "function" ) {
        return;
    }
    // note: disposal is idempotent, whichever of the generators onended-handler or this
    // fallback fires first disposes the nodes, the other one becomes a no-op
    const delayInMs = Math.max( 0, ( startTimeInSeconds + delayInSeconds - audioContext.currentTime ) * 1000 ) + 20;
    eventVoice.teardownTimer = setTimeout(() => {
        disposeVoice( instrumentModules, oscillatorIndex, eventVoice, instrumentIndex, eventVoice.eventId ?? -1 );
    }, delayInMs );
}

/**
 * return the capacity of given voice to the instrument's voice pool (if it originated from the pool).
 * Invoking this repeatedly is a no-op.
 *
 * note: when pooling of gain nodes is disabled (the stable engine configuration), the previously
 * used nodes are discarded and a fresh gain structure takes their place in the pool, so all
 * scheduled parameter changes from the previous voice are discarded.
 */
function returnVoiceCapacityToPool( instrumentModules: InstrumentModules, oscillatorIndex: number, eventVoice: EventVoice ): void {
    if ( !eventVoice || eventVoice.returned || eventVoice.fromPool === false ) {
        return;
    }
    if ( POOL_GAIN_NODES ) {
        return; // the actual nodes are returned upon disposal (see disposeVoice)
    }
    eventVoice.returned = true;
    instrumentModules.voices[ oscillatorIndex ].push( createVoiceGainStructure( instrumentModules.output ));
}

/**
 * disconnect the nodes of given voice. Invoking this repeatedly is a no-op.
 */
function disposeVoice( instrumentModules: InstrumentModules, oscillatorIndex: number,
    eventVoice: EventVoice, instrumentIndex: number, eventId: number = -1 ): void {
    if ( !eventVoice || eventVoice.disposed ) {
        return;
    }
    eventVoice.disposed = true;

    // the voice has finished sounding, its capacity can return to the pool (no-op if it
    // was already returned when playback was halted)
    returnVoiceCapacityToPool( instrumentModules, oscillatorIndex, eventVoice );

    if ( eventVoice.teardownTimer ) {
        clearTimeout( eventVoice.teardownTimer );
        eventVoice.teardownTimer = undefined;
    }

    // OscillatorNodes will automatically disconnect() after stopping
    // except for PWM which has a custom implementation
    try {
        eventVoice.generator.disconnect();
    } catch {
        // generator may have already disconnected itself
    }

    // delete the associated event from the playback list, but only when the slot
    // still references this voice (a retrigger may have claimed the slot in the meantime).
    // we delay this until the voices have actually halted playback as otherwise the
    // voices aren't always returned to the pool on Safari/iOS

    if ( eventId !== -1 && playingEventVoices[ instrumentIndex ]) {
        const voiceList = playingEventVoices[ instrumentIndex ][ eventId ];
        if ( voiceList && voiceList[ oscillatorIndex ] === eventVoice ) {
            voiceList[ oscillatorIndex ] = undefined;
            if ( voiceList.filter( Boolean ).length === 0 ) {
                delete playingEventVoices[ instrumentIndex ][ eventId ];
            }
        }
    }

    eventVoice.gain.gain.cancelScheduledValues( 0 );
    eventVoice.outputNode.gain.cancelScheduledValues( 0 );

    if ( POOL_GAIN_NODES ) {
        // return the gain nodes for the instrument voice back to the pool
        if ( eventVoice.fromPool !== false && !eventVoice.returned ) {
            eventVoice.returned = true;
            instrumentModules.voices[ oscillatorIndex ].push({
                oscillatorNode: eventVoice.gain,
                adsrNode: eventVoice.outputNode
            });
            return;
        }
    }

    // pooling of gain nodes disabled. Technically this increases work for the garbage collector, but this
    // brings the benefit of a more stable engine as it ensures all scheduled parameters are discarded, providing
    // a clean reset for the next use (otherwise over time / under CPU stress ADSR changes would not restore properly)
    // this can be tested by looping a 16th note hi-hat noise (w/ slight release) pattern for a while

    eventVoice.gain.disconnect();
    eventVoice.outputNode.disconnect();
}

/**
 * create a periodicWaveTable (which can be used with a OscillatorNode for playback) from a table of draw points.
 */
function createTableFromCustomGraph( instrumentIndex: number, oscillatorIndex: number, table: number[] ): PeriodicWave {
    return pool.CUSTOM[ instrumentIndex ][ oscillatorIndex ] = createWaveTableFromGraph( audioContext, table );
}

function createVoiceGainStructure( output: AudioNode ): InstrumentVoice {
    const oscillatorNode = createGainNode( audioContext );
    const adsrNode = createGainNode( audioContext );

    oscillatorNode.connect( adsrNode );
    adsrNode.connect( output );

    return { oscillatorNode, adsrNode };
}

/**
 * start capturing audio into the recorder (the recorder must have been created)
 */
function startRecording(): void {
    if ( !recorder || recorderState === "recording" ) {
        return;
    }
    recorderState = "recording";
    recorder.record();
}

/**
 * when a recording session was armed while playback was halted, start it now
 */
function startRecordingIfArmed(): void {
    if ( !recordOutput || !recorder || recorderState !== "idle" ) {
        return;
    }
    startRecording();
}

/**
 * stop the active recording session and export the captured audio.
 * Safe to invoke repeatedly: when no recording is active this is a no-op and
 * when an export is in progress the request is ignored (preventing duplicate exports).
 */
function stopAndExportRecording(): void {
    if ( !recordOutput ) {
        return;
    }
    if ( !recorder ) {
        recordOutput = false;
        recorderState = "idle";
        return;
    }
    if ( recorderState === "exporting" ) {
        return; // an export is already in flight, the completion handler will release resources
    }
    if ( recorderState === "idle" ) {
        // recording was only armed (playback never started), cancel and release resources
        disposeRecorder();
        return;
    }
    recorderState = "exporting";

    // the export is processed asynchronously by the recorder worker. When the worker fails to
    // report back, the recording state would remain "stuck" in exporting (blocking future
    // recordings). The watchdog ensures a new session can always be started.
    armExportWatchdog();

    try {
        recorder.stop();
        recorder.export();
    } catch ( e ) {
        // exporting failed: reset recording state so a next recording session can start anew
        handleRecordingError( e );
    }
}

/**
 * (re)arm the timer that resets a stuck export. Completion clears the timer.
 */
function armExportWatchdog(): void {
    clearExportWatchdog();
    if ( typeof setTimeout !== "function" ) {
        return;
    }
    exportWatchdog = setTimeout(() => {
        exportWatchdog = undefined;
        if ( recorderState === "exporting" ) {
            handleRecordingError( new Error( "recording export timed out" ));
        }
    }, EXPORT_TIMEOUT_MS );
}

function clearExportWatchdog(): void {
    if ( exportWatchdog ) {
        clearTimeout( exportWatchdog );
        exportWatchdog = undefined;
    }
}

/**
 * release the recorder resources and reset the recording state
 */
function disposeRecorder(): void {
    clearExportWatchdog();
    if ( recorder ) {
        try {
            recorder.dispose();
        } catch {
            // recorder resources may have been released already
        }
    }
    recorder = null;
    recorderState = "idle";
    recordOutput = false;
}

/**
 * reset the recording state after a failure so a next recording session can be started
 */
function handleRecordingError( error?: unknown ): void {
    if ( error ) {
        console.error( "output recording failed", error );
    }
    disposeRecorder();
    try {
        store?.commit?.( "showNotification", {
            message: store.getters?.t ? store.getters.t( "messages.recordingFailed" ) : "Output recording failed, please try again"
        });
    } catch {
        // notifications are best-effort
    }
}

function handleRecordingComplete( blob: Blob ): void {
    // guard against duplicate completion events (e.g. from a repeated stop request)
    if ( recorderState !== "exporting" ) {
        return;
    }
    clearExportWatchdog();
    // release the recorder resources only once, regardless of how often completion fires
    const activeRecorder = recorder;
    recorderState = "idle";
    recorder = null;
    recordOutput = false;

    try {
        if ( blob && blob.size > 0 ) {
            const blobUrl = blobToResource( blob );
            saveAsFile( blobUrl, "efflux-output.wav" );
            disposeResource( blobUrl );
            store?.commit?.( "showNotification", {
                message: store.getters?.t ? store.getters.t( "messages.recordingSaved" ) : "Recording saved"
            });
        } else {
            handleRecordingError( new Error( "recorder produced an empty recording" ));
        }
    } catch ( e ) {
        console.error( "could not save recorded output", e );
    } finally {
        // free recorder resources exactly once
        try {
            activeRecorder?.dispose();
        } catch {
            // already released
        }
    }
}
