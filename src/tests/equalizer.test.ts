import { describe, expect, it } from 'vitest';
import { createPlayer, makeTracks } from './helpers';
import { MockAudioContext, MockAudioNode } from './mocks';

describe('equalizer: idempotent attach', () => {
  it('creates one AudioContext and one media source across repeated plays and track changes', async () => {
    const { player } = await createPlayer({ enableEQ: true });
    const tracks = makeTracks(3);
    player.addQueue(tracks, 'DEFAULT');

    await player.addMedia(tracks[0]);
    await player.play();
    await player.play();
    player.attachEq();
    player.attachEq();

    // simulate a track change followed by another play
    await player.addMedia(tracks[1]);
    await player.play();

    expect(MockAudioContext.instances).toBe(1);
    expect(MockAudioContext.mediaElementSources).toBe(1);
  });

  it('does not attach the equalizer when it is not enabled', async () => {
    const { player } = await createPlayer({ enableEQ: false });
    const tracks = makeTracks(2);
    player.addQueue(tracks, 'DEFAULT');
    await player.addMedia(tracks[0]);
    await player.play();

    expect(MockAudioContext.instances).toBe(0);
  });
});

describe('equalizer: failure resilience', () => {
  it('keeps playback audible when the AudioContext cannot be created, and retries later', async () => {
    const { player, AudioX } = await createPlayer({ enableEQ: true });

    // first attempt: AudioContext construction blows up
    (globalThis as any).AudioContext = class {
      constructor() {
        throw new Error('AudioContext not allowed');
      }
    };

    const tracks = makeTracks(2);
    player.addQueue(tracks, 'DEFAULT');
    await player.addMedia(tracks[0]);
    await player.play();

    // playback still happened despite the equalizer failure
    const element = AudioX.getAudioInstance() as any;
    expect(element.paused).toBe(false);
    expect(element.playCount).toBe(1);
    expect(MockAudioContext.instances).toBe(0);

    // next enable retries with a working AudioContext
    (globalThis as any).AudioContext = MockAudioContext;
    await player.play();

    expect(MockAudioContext.instances).toBe(1);
    expect(MockAudioContext.mediaElementSources).toBe(1);

    const { Equalizer } = await import('../adapters/equalizer');
    expect(new Equalizer().status()).toBe('ACTIVE');
  });

  it('retries wiring on the same AudioContext when node graph setup fails once', async () => {
    const { player, AudioX } = await createPlayer({ enableEQ: true });

    // first createMediaElementSource call fails (e.g. element busy), second works
    let failNextSource = true;
    let sourceAttempts = 0;
    (globalThis as any).AudioContext = class extends MockAudioContext {
      createMediaElementSource() {
        sourceAttempts += 1;
        if (failNextSource) {
          failNextSource = false;
          throw new Error('InvalidStateError');
        }
        return new MockAudioNode();
      }
    };

    const tracks = makeTracks(2);
    player.addQueue(tracks, 'DEFAULT');
    await player.addMedia(tracks[0]);
    await player.play();

    // playback continued even though the first equalizer attach attempt failed
    const element = AudioX.getAudioInstance() as any;
    expect(element.paused).toBe(false);

    // the failed wiring was retried on the SAME AudioContext and recovered
    expect(MockAudioContext.instances).toBe(1);
    expect(sourceAttempts).toBe(2);
    const { Equalizer } = await import('../adapters/equalizer');
    expect(new Equalizer().status()).toBe('ACTIVE');

    // and it stays idempotent afterwards: no new context, no new source
    await player.play();
    await player.play();
    expect(MockAudioContext.instances).toBe(1);
    expect(sourceAttempts).toBe(2);
  });
});
