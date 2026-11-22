import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IVLabsPlayer } from '../src/player';
import { CuePoint, AnalyticsEvent, AnalyticsPayload } from '../src/types';

/**
 * Integration tests for a full interaction session, running against the real
 * (unmocked) player components under jsdom. They cover the four critical
 * timings: normal branch round-trip, rapid repeated clicks, segment load
 * failure / play rejection, and late callbacks arriving after destroy().
 */

const INTERACTION_CUES: CuePoint[] = [
  {
    id: 'cue-1',
    time: 5,
    payload: {
      interaction: {
        type: 'choice-video-segment-change',
        question: 'Which path do you take?',
        options: [
          { level: 'Path A', video: 'segment-a.mp4' },
          { level: 'Path B', video: 'segment-b.mp4' },
        ],
      },
    },
  },
];

const TRACKED_EVENTS: AnalyticsEvent[] = [
  'onCueEnter',
  'onPromptShown',
  'onInteractionSelected',
  'onBranchJump',
  'INTERACTION_COMPLETED',
  'onSegmentError',
  'onSessionEnd',
  'VIDEO_STARTED',
  'VIDEO_PAUSED',
  'VIDEO_ENDED',
];

type TrackedEvents = Partial<Record<AnalyticsEvent, (AnalyticsPayload | undefined)[]>>;

function createPlayer(cues: CuePoint[] = INTERACTION_CUES) {
  document.body.innerHTML = '<div id="ivl-target"></div>';
  const player = new IVLabsPlayer('ivl-target', { videoUrl: 'main.mp4', cues });
  const video = document.querySelector('#ivl-target video') as HTMLVideoElement;

  // jsdom does not implement media playback; stub it with controllable mocks.
  let rejectNextPlay = false;
  const playMock = vi.fn(() => {
    if (rejectNextPlay) {
      rejectNextPlay = false;
      return Promise.reject(new Error('play() rejected'));
    }
    return Promise.resolve();
  });
  video.play = playMock;
  video.pause = vi.fn();
  video.load = vi.fn();
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });

  const events: TrackedEvents = {};
  for (const event of TRACKED_EVENTS) {
    events[event] = [];
    player.on(event, (payload) => events[event]!.push(payload));
  }

  return {
    player,
    video,
    events,
    playMock,
    rejectNextPlay: () => {
      rejectNextPlay = true;
    },
  };
}

function fireTimeUpdate(video: HTMLVideoElement, time: number) {
  video.currentTime = time;
  video.dispatchEvent(new Event('timeupdate'));
}

function choiceButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('.ivl-choice-button'));
}

describe('Interaction session lifecycle (jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('completes a normal branch round-trip and resumes at the exact saved position', () => {
    const { player, video, events, playMock } = createPlayer();
    const mainSrc = video.src;

    // Reach the interaction point: playback pauses, prompt is shown.
    fireTimeUpdate(video, 5);
    expect(player.getState()).toBe('waitingForInteraction');
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(events.onPromptShown).toHaveLength(1);

    // Choose branch A: the segment replaces the main source.
    choiceButtons()[0].click();
    expect(events.onInteractionSelected).toHaveLength(1);
    expect(events.onBranchJump).toHaveLength(1);
    expect(events.INTERACTION_COMPLETED).toHaveLength(1);
    expect(video.src).toMatch(/segment-a\.mp4$/);

    // Segment loads and plays.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(playMock).toHaveBeenCalledTimes(1);

    // Segment ends: main video source is restored.
    video.dispatchEvent(new Event('ended'));
    expect(video.src).toBe(mainSrc);

    // Main video resumes at the exact position saved before the branch.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(5);
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(player.getState()).toBe('playing');

    // No stale resume listener survives: further loadedmetadata events are inert.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(video.currentTime).toBe(5);
  });

  it('accepts only one valid choice per interaction point despite rapid clicks and re-triggers', async () => {
    const { player, video, events } = createPlayer();

    fireTimeUpdate(video, 5);
    const [buttonA, buttonB] = choiceButtons();

    // Rapid double-click on A, then a click on B before anything settles.
    buttonA.click();
    buttonA.click();
    buttonB.click();

    // Exactly one selection, one branch jump, one completion.
    expect(events.onInteractionSelected).toHaveLength(1);
    expect(events.onBranchJump).toHaveLength(1);
    expect(events.INTERACTION_COMPLETED).toHaveLength(1);
    expect(video.src).toMatch(/segment-a\.mp4$/);

    // Exactly one decision persisted.
    await expect(player.getDecisionHistory()).resolves.toHaveLength(1);

    // Re-triggering the same cue point must not prompt or jump again.
    fireTimeUpdate(video, 5);
    fireTimeUpdate(video, 6);
    expect(events.onCueEnter).toHaveLength(1);
    expect(events.onPromptShown).toHaveLength(1);
    expect(events.onBranchJump).toHaveLength(1);
    expect(events.INTERACTION_COMPLETED).toHaveLength(1);
  });

  it('restores the main video and reports onSegmentError when the segment fails to load', () => {
    const { player, video, events, playMock } = createPlayer();
    const mainSrc = video.src;

    fireTimeUpdate(video, 5);
    choiceButtons()[0].click();
    expect(video.src).toMatch(/segment-a\.mp4$/);

    // The segment fails to load.
    video.dispatchEvent(new Event('error'));

    // State converges back to playing, source is restored, failure is reported.
    expect(events.onSegmentError).toHaveLength(1);
    expect(events.onSegmentError![0]?.data.segmentUrl).toBe('segment-a.mp4');
    expect(player.getState()).toBe('playing');
    expect(video.src).toBe(mainSrc);

    // The main video resumes from the original interaction point.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(5);
    expect(playMock).toHaveBeenCalledTimes(1);

    // The failure path must not produce a second completion or branch jump.
    expect(events.INTERACTION_COMPLETED).toHaveLength(1);
    expect(events.onBranchJump).toHaveLength(1);
  });

  it('restores the main video and reports onSegmentError when segment playback is rejected', async () => {
    const { player, video, events, playMock, rejectNextPlay } = createPlayer();
    const mainSrc = video.src;

    fireTimeUpdate(video, 5);
    choiceButtons()[0].click();

    // The segment loads but play() is rejected (e.g. autoplay policy).
    rejectNextPlay();
    video.dispatchEvent(new Event('loadedmetadata'));

    await vi.waitFor(() => expect(events.onSegmentError).toHaveLength(1));
    expect(player.getState()).toBe('playing');
    expect(video.src).toBe(mainSrc);

    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(5);
    expect(playMock).toHaveBeenCalledTimes(2); // rejected segment play + successful resume
  });

  it('ignores late segment callbacks and interaction responses after destroy', () => {
    const { player, video, events, playMock } = createPlayer();

    fireTimeUpdate(video, 5);
    choiceButtons()[0].click(); // segment is now loading (loadedmetadata pending)
    expect(video.src).toMatch(/segment-a\.mp4$/);

    player.destroy();
    expect(events.onSessionEnd).toHaveLength(1);
    const srcAtDestroy = video.src;
    const stateAtDestroy = player.getState();

    // Late callbacks: segment load completes, play rejects, segment ends,
    // errors and time updates arrive — none of them may have any effect.
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('ended'));
    video.dispatchEvent(new Event('error'));
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('pause'));
    fireTimeUpdate(video, 10);

    expect(video.src).toBe(srcAtDestroy);
    expect(playMock).not.toHaveBeenCalled();
    expect(player.getState()).toBe(stateAtDestroy);
    expect(events.onBranchJump).toHaveLength(1);
    expect(events.INTERACTION_COMPLETED).toHaveLength(1);
    expect(events.onSegmentError).toHaveLength(0);
    expect(events.VIDEO_STARTED).toHaveLength(0);
    expect(events.VIDEO_PAUSED).toHaveLength(0);
    expect(events.VIDEO_ENDED).toHaveLength(0);
    expect(events.onPromptShown).toHaveLength(1);
  });

  it('ignores a late interaction click that arrives after destroy', () => {
    const { player, video, events } = createPlayer();
    const mainSrc = video.src;

    fireTimeUpdate(video, 5);
    const button = choiceButtons()[0];

    player.destroy();
    button.click(); // overlay is detached, callback is gone

    expect(events.onInteractionSelected).toHaveLength(0);
    expect(events.onBranchJump).toHaveLength(0);
    expect(events.INTERACTION_COMPLETED).toHaveLength(0);
    expect(video.src).toBe(mainSrc);
  });

  it('removes listeners on destroy so a recreated player does not double-trigger cues', () => {
    const first = createPlayer();
    fireTimeUpdate(first.video, 5);
    expect(first.events.onPromptShown).toHaveLength(1);
    first.player.destroy();

    // Recreate a player on the same target.
    const second = createPlayer();
    fireTimeUpdate(second.video, 5);

    // The new player prompts exactly once; the old player's listeners stay silent.
    expect(document.querySelectorAll('.ivl-interaction-overlay')).toHaveLength(1);
    expect(second.events.onPromptShown).toHaveLength(1);
    expect(second.events.onCueEnter).toHaveLength(1);
    expect(first.events.onPromptShown).toHaveLength(1);
    expect(first.events.onCueEnter).toHaveLength(1);
  });
});
