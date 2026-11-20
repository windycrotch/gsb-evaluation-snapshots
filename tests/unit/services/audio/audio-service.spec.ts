import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import OscillatorTypes from "@/definitions/oscillator-types";
import InstrumentFactory from "@/model/factories/instrument-factory";
import SongFactory from "@/model/factories/song-factory";
import EventFactory from "@/model/factories/event-factory";
import { ACTION_NOTE_ON } from "@/model/types/audio-event";
import { VOLUME, PAN_RIGHT, FILTER_FREQ } from "@/definitions/automatable-parameters";
import type { EffluxSong } from "@/model/types/song";
import type { Instrument, InstrumentOscillator } from "@/model/types/instrument";
import type { EventVoice } from "@/model/types/event-voice";
import { createMockStore } from "../../mocks";
import {
    createMockAudioContext, MockOscillatorNode, MockAudioBufferSourceNode, MockAudioParam, GainNode as MockGainNode
} from "./mock-web-audio";

// the module router performs instanceof checks against the global GainNode constructor
(globalThis as any).GainNode = (globalThis as any).GainNode ?? MockGainNode;

const asMockBufferSource = ( node: unknown ): MockAudioBufferSourceNode => node as MockAudioBufferSourceNode;
const asMockParam = ( param: unknown ): MockAudioParam => param as MockAudioParam;

// the OutputRecorder class is worker based, replace it with a controllable mock

const recorderInstances: MockOutputRecorder[] = [];

class MockOutputRecorder
{
    public recording = false;
    public stopCalls = 0;
    public exportCalls = 0;
    public disposeCalls = 0;
    public callback: ( blob: Blob ) => void;

    constructor( _source: unknown, { callback }: { callback: ( blob: Blob ) => void }) {
        this.callback = callback;
        recorderInstances.push( this );
    }

    record(): void {
        this.recording = true;
    }

    stop(): void {
        ++this.stopCalls;
        this.recording = false;
    }

    export(): void {
        ++this.exportCalls;
    }

    dispose(): void {
        ++this.disposeCalls;
    }

    // test helper: simulate the worker producing recorded audio
    complete( blob: Blob = new Blob([ new Uint8Array( 16 ) ], { type: "audio/wav" })): void {
        this.callback( blob );
    }
}

vi.mock( "@/utils/file-util", () => ({
    saveAsFile: vi.fn(),
}));

vi.mock( "@/utils/resource-manager", () => ({
    blobToResource: vi.fn(() => "blob:efflux-output"),
    disposeResource: vi.fn(),
}));

import { saveAsFile } from "@/utils/file-util";

const waveTables = {
    [ OscillatorTypes.SINE ]:     { real: [ 0, 0 ], imag: [ 0, 1 ] },
    [ OscillatorTypes.SAW ]:      { real: [ 0, 0 ], imag: [ 0, 1 ] },
    [ OscillatorTypes.TRIANGLE ]: { real: [ 0, 0 ], imag: [ 0, 1 ] },
    [ OscillatorTypes.SQUARE ]:   { real: [ 0, 0 ], imag: [ 0, 1 ] },
};

describe( "AudioService", () => {
    let AudioService: typeof import("@/services/audio-service").default;
    let context: any;
    let song: EffluxSong;
    let store: any;

    const createNoiseInstrument = (): Instrument => {
        const instrument = InstrumentFactory.create( 0 );
        instrument.oscillators = [
            {
                ...InstrumentFactory.createOscillator( true, OscillatorTypes.NOISE ),
                // a long release, like the hi-hat in the problem description
                adsr: { attack: 0, decay: 0, sustain: 1, release: 0.4 },
            },
        ];
        instrument.filter.enabled = true;
        instrument.filter.frequency = 880;
        instrument.panning = 0;
        return instrument;
    };

    const getAvailableVoices = ( instrumentIndex: number, oscillatorIndex: number ): number => {
        return AudioService.getVoicePoolStats()
            .find( stats => stats.instrumentIndex === instrumentIndex && stats.oscillatorIndex === oscillatorIndex )!
            .available;
    };

    const getPlayingVoices = ( instrumentIndex: number, oscillatorIndex: number ): number => {
        return AudioService.getVoicePoolStats()
            .find( stats => stats.instrumentIndex === instrumentIndex && stats.oscillatorIndex === oscillatorIndex )!
            .playing;
    };

    const noteOn = ( instrument: Instrument, note = "C", octave = 3 ): any => {
        const event = EventFactory.create( instrument.index, note, octave, ACTION_NOTE_ON );
        AudioService.noteOn( event, instrument, new Map());
        return event;
    };

    const getEventVoice = ( event: any ): EventVoice => {
        const voiceList = AudioService.getPlayingEventVoices()[ event.instrument ][ event.id ];
        return voiceList.find( Boolean );
    };

    beforeEach( async () => {
        vi.useFakeTimers();
        recorderInstances.length = 0;

        context = createMockAudioContext();
        song  = SongFactory.create( 2 );
        song.instruments = [ createNoiseInstrument(), InstrumentFactory.create( 1 ) ];

        store = createMockStore();
        store.state.song.activeSong = song;

        // load a fresh module instance so module state does not leak between tests
        vi.resetModules();
        AudioService = ( await import( "@/services/audio-service" )).default;
        AudioService.prepareEnvironment( context, waveTables );
        AudioService.applyModules( song );
        AudioService.setStore( store );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        ( saveAsFile as any ).mockClear?.();
    });

    describe( "voice pool lifecycle", () => {
        it( "should return all voices to the instrument pool when playback stops", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            const events = [ noteOn( instrument ), noteOn( instrument, "D" ), noteOn( instrument, "E" ) ];
            events.forEach( event => expect( getEventVoice( event )).toBeTruthy() );

            expect( getPlayingVoices( 0, 0 )).toEqual( 3 );
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices - 3 );

            AudioService.togglePlayback( false );

            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
        });

        it( "should keep the voice available for a new note after playback has been stopped and restarted repeatedly", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            for ( let i = 0; i < 10; ++i ) {
                AudioService.togglePlayback( true );
                const event = noteOn( instrument );
                expect( getEventVoice( event )).toBeTruthy();
                AudioService.togglePlayback( false );
            }
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );

            // and the instrument can still acquire a voice
            AudioService.togglePlayback( true );
            const event = noteOn( instrument );
            expect( getEventVoice( event )).toBeTruthy();
        });

        it( "should apply the release envelope (and schedule the stop after the release) when playback stops", () => {
            const instrument = song.instruments[ 0 ];
            const event = noteOn( instrument );
            const voice  = getEventVoice( event );
            const generator = asMockBufferSource( voice.generator );

            AudioService.togglePlayback( false );

            // release is applied onto the envelope, the generator is stopped after the release time
            expect( asMockParam( voice.outputNode.gain ).scheduled.some( entry => entry.type === "linear" && entry.value === 0 )).toBe( true );
            expect( generator.stopped ).toBe( true );
            expect( generator.stopTime ).toBeGreaterThanOrEqual( instrument.oscillators[ 0 ].adsr.release );
        });

        it( "should not return a voice twice when the generator finishes after a reset", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            const event = noteOn( instrument );
            const voice  = getEventVoice( event );
            const generator = asMockBufferSource( voice.generator );

            AudioService.togglePlayback( false );
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices ); // already returned

            // the generator finishes (onended) after the voice was already returned
            generator.finish();
            // and a reset is requested once more
            AudioService.togglePlayback( false );

            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
        });

        it( "should return the voice to the pool once the release envelope has completed", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            const event = noteOn( instrument );
            const generator = asMockBufferSource( getEventVoice( event ).generator );

            AudioService.noteOff( event );
            // noteOff alone does not return the voice, it is still in its release phase
            expect( getPlayingVoices( 0, 0 )).toEqual( 1 );

            generator.finish(); // release has completed

            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );
        });

        it( "should return the voice to the pool via the scheduled fallback when the generator does not report its end", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            const event = noteOn( instrument );
            AudioService.togglePlayback( false );

            // voice is returned immediately on reset (release is applied before returning)
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );

            // no double return when the fallback timer fires (generator never reported onended)
            vi.runAllTimers();
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
        });

        it( "should not silently drop notes when the pool is exhausted, and report the degradation", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            const warnSpy = vi.spyOn( console, "warn" ).mockImplementation(() => {});

            const events = [];
            for ( let i = 0; i < initialVoices + 4; ++i ) {
                events.push( noteOn( instrument ));
            }
            // all notes are sounding, no silent drops
            expect( getPlayingVoices( 0, 0 )).toEqual( initialVoices + 4 );
            expect( AudioService.getVoiceOverflowCount() ).toBeGreaterThan( 0 );
            expect( warnSpy ).toHaveBeenCalled();
            expect( store.commit ).toHaveBeenCalledWith( "showNotification", expect.any( Object ));

            // the pool does not grow beyond its canonical size once playback stops
            AudioService.togglePlayback( false );
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );
        });

        it( "should recover voices after rapid retriggering with long release tails", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            vi.spyOn( console, "warn" ).mockImplementation(() => {});

            // retain each released generator so we can simulate its tail ending later
            const tails: MockAudioBufferSourceNode[] = [];

            // trigger and release notes faster than their release envelope completes. While the
            // tails are sounding their capacity is retained, so a sustained run of notes will
            // exhaust the pool (which must degrade observably, not silently drop the note)
            for ( let i = 0; i < initialVoices + 2; ++i ) {
                const event = noteOn( instrument, "C", 3 );
                tails.push( asMockBufferSource( getEventVoice( event ).generator ));
                AudioService.noteOff( event );
            }
            expect( AudioService.getVoiceOverflowCount() ).toBeGreaterThan( 0 );
            expect( getPlayingVoices( 0, 0 )).toEqual( initialVoices + 2 );

            // once the release tails complete, every voice is returned to the pool
            tails.forEach( tail => tail.finish());

            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );

            // and the instrument can still acquire voices for new notes
            const event = noteOn( instrument );
            expect( getEventVoice( event )).toBeTruthy();
            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices - 1 );
        });

        it( "should handle repeated stop requests idempotently", () => {
            const instrument = song.instruments[ 0 ];
            const initialVoices = getAvailableVoices( 0, 0 );

            noteOn( instrument );
            noteOn( instrument, "D" );

            expect(() => {
                AudioService.togglePlayback( false );
                AudioService.togglePlayback( false );
                AudioService.reset();
                AudioService.reset( true );
            }).not.toThrow();

            expect( getAvailableVoices( 0, 0 )).toEqual( initialVoices );
            expect( getPlayingVoices( 0, 0 )).toEqual( 0 );
        });
    });

    describe( "module automation state", () => {
        const automate = ( event: any, module: string, value: number ): void => {
            event.mp = { module, value, glide: false };
            AudioService.noteOn( event, song.instruments[ event.instrument ], new Map(), 0 );
        };

        it( "should restore automated module parameters to the song model values when playback stops", () => {
            const instrument = song.instruments[ 0 ];
            const modules = AudioService.getInstrumentModules( 0 );

            const modelPan = instrument.panning;
            const modelFreq = instrument.filter.frequency;

            expect( modules.panner.pan.value ).toEqual( modelPan );
            expect( modules.filter.filter.frequency.value ).toEqual( modelFreq );

            const event = noteOn( instrument );
            automate( event, PAN_RIGHT, 100 );
            automate( noteOn( instrument ), FILTER_FREQ, 5 );

            // automation changed the runtime values
            expect( modules.panner.pan.value ).not.toEqual( modelPan );
            expect( modules.filter.filter.frequency.value ).not.toEqual( modelFreq );

            AudioService.togglePlayback( false );

            // values are restored to the song model values
            expect( modules.panner.pan.value ).toEqual( modelPan );
            expect( modules.filter.filter.frequency.value ).toEqual( modelFreq );
        });

        it( "should cancel scheduled module automation values on stop", () => {
            const instrument = song.instruments[ 0 ];
            const modules = AudioService.getInstrumentModules( 0 );

            const event = noteOn( instrument );
            event.mp = { module: FILTER_FREQ, value: 100, glide: true };
            AudioService.noteOn( event, instrument, new Map(), 0 );

            const frequencyParam = asMockParam( modules.filter.filter.frequency );
            expect( frequencyParam.scheduled.length ).toBeGreaterThan( 0 );

            AudioService.togglePlayback( false );

            expect( frequencyParam.cancelCalls.length ).toBeGreaterThan( 0 );
            expect( frequencyParam.scheduled.length ).toEqual( 0 );
            expect( frequencyParam.value ).toEqual( instrument.filter.frequency );
        });

        it( "should not mutate the song model when automating the filter LFO type", () => {
            const instrument = song.instruments[ 0 ];
            const modelLfoType = instrument.filter.lfoType;

            const event = noteOn( instrument );
            automate( event, "filterLfoEnabled", 100 );

            expect( instrument.filter.lfoType ).toEqual( modelLfoType );

            AudioService.togglePlayback( false );
            expect( instrument.filter.lfoType ).toEqual( modelLfoType );
        });
    });

    describe( "output recording", () => {
        beforeEach(() => {
            AudioService.configureOutputRecorder( MockOutputRecorder as any );
        });

        it( "should export exactly once when playback stops while recording", () => {
            AudioService.toggleRecordingState(); // arm recording
            AudioService.togglePlayback( true ); // starts capturing

            const recorder = recorderInstances[ recorderInstances.length - 1 ];
            expect( recorder.recording ).toBe( true );

            AudioService.togglePlayback( false );

            expect( recorder.stopCalls ).toEqual( 1 );
            expect( recorder.exportCalls ).toEqual( 1 );
            expect( AudioService.getRecordingState() ).toEqual( "exporting" );

            recorder.complete();

            expect( recorder.disposeCalls ).toEqual( 1 );
            expect( saveAsFile ).toHaveBeenCalledOnce();
            expect( AudioService.isRecording() ).toEqual( false );
            expect( AudioService.getRecordingState() ).toEqual( "idle" );
        });

        it( "should ignore repeated stop requests while an export is in flight", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            const recorder = recorderInstances[ recorderInstances.length - 1 ];

            AudioService.togglePlayback( false );
            // repeated stops / toggles must not produce duplicate downloads or throw
            expect(() => {
                AudioService.togglePlayback( false );
                AudioService.togglePlayback( false );
                AudioService.toggleRecordingState();
            }).not.toThrow();

            expect( recorder.exportCalls ).toEqual( 1 );

            recorder.complete();
            expect( recorder.disposeCalls ).toEqual( 1 );
            expect( saveAsFile ).toHaveBeenCalledOnce();
        });

        it( "should only release the recorder once when completion fires repeatedly", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            const recorder = recorderInstances[ recorderInstances.length - 1 ];
            AudioService.togglePlayback( false );

            recorder.complete();
            recorder.complete(); // duplicate completion event

            expect( recorder.disposeCalls ).toEqual( 1 );
            expect( saveAsFile ).toHaveBeenCalledOnce();
        });

        it( "should reset the recording state when exporting fails, allowing a new recording to be started", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            const failingRecorder = recorderInstances[ recorderInstances.length - 1 ];
            failingRecorder.export = (): void => {
                throw new Error( "export failed" );
            };

            expect(() => AudioService.togglePlayback( false )).not.toThrow();

            expect( AudioService.isRecording() ).toEqual( false );
            expect( AudioService.getRecordingState() ).toEqual( "idle" );

            // a next recording session can be started and exports successfully
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );
            AudioService.togglePlayback( false );

            const secondRecorder = recorderInstances[ recorderInstances.length - 1 ];
            expect( secondRecorder ).not.toBe( failingRecorder );
            secondRecorder.complete();

            expect( saveAsFile ).toHaveBeenCalledOnce();
        });

        it( "should not export when recording was armed but playback never started", () => {
            AudioService.toggleRecordingState(); // arm with no playback
            AudioService.togglePlayback( false );

            expect( recorderInstances.every( recorder => recorder.exportCalls === 0 )).toBe( true );
            expect( AudioService.isRecording() ).toEqual( false );
            expect( AudioService.getRecordingState() ).toEqual( "idle" );
        });

        it( "should keep recording a subsequent session after a completed export", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );
            AudioService.togglePlayback( false );
            recorderInstances[ recorderInstances.length - 1 ].complete();

            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            const secondRecorder = recorderInstances[ recorderInstances.length - 1 ];
            expect( secondRecorder ).not.toBe( recorderInstances[ 0 ]);
            expect( secondRecorder.recording ).toBe( true );
            expect( AudioService.isRecording() ).toEqual( true );
        });

        it( "should not produce a duplicate download when playback is restarted before the export completes", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            const recorder = recorderInstances[ recorderInstances.length - 1 ];
            AudioService.togglePlayback( false ); // export in flight

            expect(() => {
                AudioService.togglePlayback( true ); // restart before export completed
                AudioService.togglePlayback( false );
            }).not.toThrow();

            expect( recorder.exportCalls ).toEqual( 1 );
            expect( recorder.disposeCalls ).toEqual( 0 );

            recorder.complete();

            expect( recorder.exportCalls ).toEqual( 1 );
            expect( recorder.disposeCalls ).toEqual( 1 );
            expect( saveAsFile ).toHaveBeenCalledOnce();
        });

        it( "should reset a stuck export after the export watchdog elapses", () => {
            AudioService.toggleRecordingState();
            AudioService.togglePlayback( true );

            AudioService.togglePlayback( false ); // export never completes (simulating a worker failure)
            expect( AudioService.getRecordingState() ).toEqual( "exporting" );

            vi.advanceTimersByTime( 31_000 );

            expect( AudioService.getRecordingState() ).toEqual( "idle" );
            expect( AudioService.isRecording() ).toEqual( false );

            // a new session can be started
            AudioService.toggleRecordingState();
            expect( AudioService.isRecording() ).toEqual( true );
        });
    });
});
