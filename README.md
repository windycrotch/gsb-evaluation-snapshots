# DSP Playground

DSP Playground is a browser-based digital signal processing playground for designing, visualizing, and testing real-time audio algorithms, effects, reverbs, and synthesizers through an intuitive node graph powered by the Web Audio API.

[▶ Try DSP Playground in your browser](https://thehugh100.github.io/dsp-playground)


## Features

- **Visual Node Graph Editor**: Connect audio processing nodes with an intuitive drag-and-drop interface
- **Real-Time Audio Processing**: Hear your changes instantly with low-latency Web Audio API processing
- **DSP Nodes**: Including Filters, delays, pitch shifters, modulators, and more
- **Advanced Reverb Design**: Specialized nodes for allpass filters, comb filters, diffusers, and feedback delay networks
- **Modulation System**: LFOs, chaos generators, and parameter automation with multiple routing modes
- **Preset System**: Save and load your creations, includes classic reverb topologies
- **Keyboard Control**: Play musical notes with QWERTY keyboard for testing pitched effects

## Quick Start

1. Clone the repository
2. Serve the directory with a local web server:
   ```bash
   python -m http.server 8000
   # or
   npx http-server
   ```
3. Open `http://localhost:8000` in your browser
4. Click "Start Audio Engine" and begin building

Note: Modern browsers require HTTPS or localhost for Web Audio API features.

## Use Cases

- Design custom reverb algorithms
- Prototype audio effects and signal chains
- Learn DSP concepts through visual experimentation
- Create unique modulation and synthesis patches
- Analyze audio signal flow and processing graphs

## Available Nodes

**Audio I/O**: Audio Source, Stereo Output, Microphone Input  
**Effects**: Delay, Pitch Shifter, Ring Modulator, Distortion  
**Filters**: Lowpass, Highpass, Bandpass, Notch, Allpass  
**Reverb Components**: Comb Filter, Allpass Delay, Diffuser, FDN (Feedback Delay Network)  
**Mixing**: Mixer, Wet/Dry, Panner, Gain, Mono  
**Modulation**: LFO, Chaos Generator, Sample & Hold  
**Utilities**: Adder, Multiplier, Inverter, Absolute, Value

## Project Structure

```
dsp-playground/
├── index.html              # Application entry point
├── css/styles.css          # Interface styling
├── js/
│   ├── app.js             # Main application logic
│   ├── core/              # Base DSP node classes
│   ├── nodes/             # Individual node implementations
│   ├── utils/             # Audio utilities
│   └── worklets/          # AudioWorklet processors
├── tests/
│   ├── modulation-tests.html    # Browser test page for the modulation chain
│   ├── modulation-tests.js      # Shared test suite (browser + Node)
│   └── run-modulation-tests.mjs # Headless Node runner
└── presets/               # Example configurations
```

## Tests

The modulation chain (connection modes, per-param strategies, save/load round
trip) is covered by a self-contained suite:

- **Browser**: serve the repo and open `tests/modulation-tests.html` — results
  render on the page and in the console (`window.modulationTestResults`).
- **Headless**: `node tests/run-modulation-tests.mjs` runs the same suite
  against a mock AudioContext.

## Technology

Built with vanilla JavaScript using:
- Web Audio API for audio processing
- AudioWorklet API for high-performance effects
- Canvas API for visual node graph rendering
- ES6 modules for clean code organization

## Browser Compatibility

Requires a modern browser with Web Audio API and AudioWorklet support:
- Chrome 66+
- Firefox 76+
- Safari 14.1+
- Edge 79+

## License

MIT License - see LICENSE file for details
