# libadlmidi-js

WebAssembly build of [libADLMIDI](https://github.com/Wohlstand/libADLMIDI) - a free Software MIDI synthesizer library with OPL3 (FM synthesis) emulation.

Check out some [examples](https://libadlmidi-js.github.io):
- [oplsfxr](https://libadlmidi-js.github.io/examples/oplsfxr.html)
- [midi player](https://libadlmidi-js.github.io/examples/player.html)
- [keyboard](https://libadlmidi-js.github.io/examples/keyboard.html)
- [patch editor](https://libadlmidi-js.github.io/examples/patch-editor.html)
- [midi to wav](https://libadlmidi-js.github.io/examples/midi-to-audio.html)
- [connect any midi controller](https://libadlmidi-js.github.io/examples/webmidi.html)
- [tr-262 drum machine](https://libadlmidi-js.github.io/examples/tr-262.html)
- [opl breaker](https://libadlmidi-js.github.io/examples/opl-breaker.html)

## Features

- **AudioWorklet Integration**: Runs synthesis in a separate thread to prevent UI stuttering. Interoperates with all the usual browser audio APIs.
- **WOPL Bank Support**: Load custom FM banks or use the high-quality embedded banks.
- **Real-time API**: Fine-grained control over MIDI channels, notes, and controllers.
- **Instrument Editing**: Programmatic access to OPL3 operator parameters.

## Installation

```bash
npm install libadlmidi-js
```

## Quick Start (Browser + AudioWorklet)

```javascript
import { AdlMidi } from 'libadlmidi-js/nuked';

const synth = new AdlMidi();
await synth.init();

// Play a middle C on channel 0
synth.noteOn(0, 60, 100);

// Stop it after 1 second
setTimeout(() => {
    synth.noteOff(0, 60);
}, 1000);
```

## CDN Usage

You can load the library from a CDN to use it right away.

**unpkg** or **jsdelivr**:
```html
<script type="module">
  import { AdlMidi } from 'https://unpkg.com/libadlmidi-js/src/profiles/light.js';
  // or: https://cdn.jsdelivr.net/npm/libadlmidi-js/src/profiles/light.js

  const synth = new AdlMidi();
  await synth.init();
</script>
```

**esm.sh** requires explicit URLs:
```html
<script type="module">
  import { AdlMidi } from 'https://esm.sh/libadlmidi-js/src/libadlmidi.js';

  const synth = new AdlMidi();
  await synth.init(
    'https://esm.sh/libadlmidi-js/dist/libadlmidi.light.processor.js?raw',
    'https://esm.sh/libadlmidi-js/dist/libadlmidi.light.core.wasm?raw'
  );
</script>
```

## Low-Level API (Node.js / Custom Backends)

For batch rendering, custom audio backends, or non-browser environments:

```javascript
import { AdlMidiCore } from 'libadlmidi-js/nuked';

const synth = await AdlMidiCore.create();

synth.init(44100);
synth.setBank(72);

// Real-time synthesis
synth.noteOn(0, 60, 100);
const samples = synth.generate(4096);  // Float32Array, stereo interleaved

// Or MIDI file playback
import { readFileSync } from 'fs';
synth.loadMidi(readFileSync('song.mid'));
while (!synth.atEnd) {
  const audio = synth.play(4096);
  // ... write to file or audio output
}

synth.close();
```

### Slim Builds (No Embedded Banks)

For smaller bundles, use slim variants and load banks at runtime:

```javascript
import { AdlMidi } from 'libadlmidi-js/nuked/slim';

const synth = new AdlMidi();
await synth.init();
await synth.loadBankFile('./mybank.wopl');  // Load WOPL bank
```

### Struct Utilities

For direct OPL3 instrument manipulation:

```javascript
import { AdlMidi } from 'libadlmidi-js/nuked';
import { encodeInstrument, decodeInstrument, defaultInstrument } from 'libadlmidi-js/structs';

const synth = new AdlMidi();
await synth.init();

// Create a custom instrument from the default template
const inst = defaultInstrument();
inst.operators[0].attack = 15;
inst.operators[0].decay = 8;
inst.feedback1 = 7;

// Encode and apply to channel 0
const bytes = encodeInstrument(inst);  // 40-byte Uint8Array
synth.setCustomInstrument(0, bytes);

// Notes on channel 0 now use the custom instrument
synth.noteOn(0, 60, 100);

// You can also decode instrument data from a bank
const decoded = decodeInstrument(bytes);
```

### Atomic Channel Programming

Direct `rawOPL3()` writes are applied one register at a time, so an invalid
parameter or a mid-sequence failure can leave a channel half-programmed
(dumb notes, leftover noise, cross-channel bleed). The `opl3-channel` module
wraps a channel programming request in an all-or-nothing transaction:

```javascript
import { AdlMidiCore } from 'libadlmidi-js/core';
import { createRawOPL3Writer, programChannel } from 'libadlmidi-js/opl3-channel';
import { channelMask } from 'libadlmidi-js/opl3';

const synth = await AdlMidiCore.create({ corePath: './libadlmidi.nuked.core.js' });
synth.init(44100);
synth.reserveChipChannels(0, channelMask(0)); // keep the MIDI allocator away

// One writer per chip; serializes transactions and tracks register state.
const writer = createRawOPL3Writer(synth, 0);

const result = await programChannel(writer, {
    instrument,   // 2-op ADL instrument
    channel: 0,   // 0-17
    fnum: 512,    // optional: 0-1023
    block: 4,     // optional: 0-7 (required together with fnum)
    keyOn: true,  // optional: set the key-on bit on the B0 write
});

if (!result.ok) {
    // 'rejected'      -> validation failed before any write (chip untouched)
    // 'commit_failed' -> a write threw; pre-call state was rolled back
    // 'rollback_failed' -> rollback also failed; details in result.rollbackErrors
    console.error(result.code, result.error);
}
```

Guarantees:

- **Validate before write**: channel (0-17), fnum (0-1023), block (0-7) and
  every register address (0x000-0x1FF) are checked and all bytes encoded
  before the chip is touched, so a rejected request leaves no trace.
- **Atomic commit with rollback**: if the underlying writer throws mid-batch,
  the registers already written are restored from a pre-commit snapshot;
  rollback failures are reported per register, never swallowed.
- **Concurrency isolation**: requests through one writer execute serially via
  an internal mutex, so interleaved programming of different channels can
  never split or overwrite each other's register sets.
- **Idempotent replay**: replaying the identical request performs zero
  physical writes once the shadow state matches.

## Profiles

| Profile | Emulator(s) | Usage |
|---------|-------------|-------|
| `nuked` | Nuked OPL3 v1.8 + Nuked OPL3 Fast | Maximum accuracy. Defaults to Nuked Fast (bit-exact vs Nuked 1.8, faster). |
| `dosbox` | DosBox OPL3 | Great balance of speed and accuracy. |
| `light` | Nuked + Nuked Fast, DosBox | Flexible for varied performance needs. Defaults to Nuked Fast. |
| `full` | All supported | Includes Opal, Java OPL3, ESFMu, etc. Defaults to Nuked Fast where available. |

To opt back to the original Nuked 1.8, pass `{ emulator: Emulator.NUKED }` as the third argument to `init()`, or call `await synth.switchEmulator(Emulator.NUKED)` after init.

## Documentation

See the `examples/` directory for advanced usage, including:
- `player.html`: MIDI file playback.
- `keyboard.html`: Real-time interaction.
- `patch-editor.html`: Live OPL3 patch editing.
- `opl-breaker.html`: Raw OPL3 + MIDI playback integration.

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and rules.

## License

This project is licensed under the **LGPL-3.0**. See the [LICENSE](LICENSE) file for details.
Upstream libADLMIDI is licensed under a mix of GPL and LGPL; see the `libADLMIDI/LICENSE` for core engine licensing.

