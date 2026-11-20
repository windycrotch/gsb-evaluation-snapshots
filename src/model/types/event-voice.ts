/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2016-2022 - https://www.igorski.nl
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
import type { InstrumentOscillator } from "./instrument";

/**
 * describes a single voice for an event (an event is
 * a note being triggered for an instrument, however the
 * instrument can have multiple voices / oscillators)
 * which are bundled for a single event in an EventVoiceList
 */
export type EventVoice = {
    generator: OscillatorNode | AudioBufferSourceNode;
    gain: GainNode;
    outputNode: GainNode;
    frequency: number;
    vo: InstrumentOscillator,
    gliding: false,
    // playback lifecycle bookkeeping, set by the AudioService:

    // identifier of the EffluxAudioEvent this voice is playing back for
    eventId?: number,
    // whether the release envelope has been applied (prevents double releases)
    released?: boolean,
    // whether the voice capacity has been returned to the instruments pool
    returned?: boolean,
    // whether the voice's nodes have been disconnected (prevents double disposal)
    disposed?: boolean,
    // whether the voice gain structure originated from the pool (and should be returned to it)
    fromPool?: boolean,
    // handle to the safety-net timer that disposes the voice if the generator
    // does not report its end (cleared when the voice is disposed)
    teardownTimer?: ReturnType<typeof setTimeout>
};

/**
 * all voices thay are playing back for a single instrument event
 */
export type EventVoiceList = EventVoice[];
