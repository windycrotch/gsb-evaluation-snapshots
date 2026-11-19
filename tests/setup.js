/**
 * Minimal browser globals required to import the r-audio source modules
 * in a plain Node environment, without any real audio device.
 */
global.window = global.window || {};

class AudioContextStub {}

global.window.AudioContext = global.window.AudioContext || AudioContextStub;
global.window.webkitAudioContext = global.window.webkitAudioContext || AudioContextStub;
global.AudioContext = global.AudioContext || AudioContextStub;
