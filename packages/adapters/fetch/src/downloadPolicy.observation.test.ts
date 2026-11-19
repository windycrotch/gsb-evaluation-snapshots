import {
  downloadPolicyFor,
  readSampleTable,
  seconds,
  startFileDownload,
  type ContainerCodecs,
  type DownloadPolicy,
  type DownloadedFile,
  type TrackColour,
} from '@gyroview/core';
import {
  buildMp4File,
  type FixtureTrack,
  UNSPECIFIED_COLOUR,
  videoSampleEntry,
} from '@gyroview/core/testing';
import { describe, expect, it } from 'vitest';

import { HttpByteStream } from './HttpByteStream';
import { HttpRangeSource } from './HttpRangeSource';
import { HttpResource } from './HttpResource';
import { RangeServer } from './test/rangeServer';

const URL = 'https://media.example/recording.insv';
const MEBIBYTE = 2 ** 20;

/**
 * Builds a downloadable MP4 of one video track: `frames` samples of `sampleBytes` each, ten a
 * second, with a no-op codec configuration the core accepts without a real codec reader.
 */
function downloadableFile(
  frames: number,
  sampleBytes: number,
): { readonly bytes: Uint8Array; readonly codecs: ContainerCodecs } {
  const samples = Array.from({ length: frames }, (_, frame) => ({
    bytes: new Uint8Array(sampleBytes).fill(1),
    duration: 9000,
    isSync: frame % 10 === 0,
  }));
  const track: FixtureTrack = {
    trackId: 1,
    handler: 'vide',
    sampleEntry: videoSampleEntry({
      type: 'tstv',
      width: 64,
      height: 64,
      configuration: new Uint8Array(),
    }),
    timescale: 90_000,
    samples,
    syncSamples: 'listed',
  };
  const built = buildMp4File([track]);
  const colour: TrackColour = UNSPECIFIED_COLOUR;
  const codecs: ContainerCodecs = {
    video: [
      {
        trackId: 1,
        description: { trackIndex: 0, codec: 'tstv', codedWidth: 64, codedHeight: 64, colour },
        configuration: {
          codec: 'tstv',
          codedWidth: 64,
          codedHeight: 64,
          description: undefined,
          colour,
        },
      },
    ],
    audio: [],
  };
  return { bytes: built.bytes, codecs };
}

interface Opened {
  readonly policy: DownloadPolicy;
  readonly file: DownloadedFile;
  readonly rangesAsked: () => readonly string[];
}

/**
 * Opens the served bytes exactly as the player does: one HttpResource behind both the random
 * access source and the byte stream, the sample table read over ranges, and the download started
 * with the policy chosen from the resource's observed answer wait (ADR 0044).
 */
async function openDownload(
  server: RangeServer,
  bytes: Uint8Array,
  codecs: ContainerCodecs,
): Promise<Opened> {
  const resource = new HttpResource(URL, { fetch: server.fetch, retryDelaysMs: [0, 0] });
  const source = new HttpRangeSource(resource);
  const stream = new HttpByteStream(resource);
  const { table } = await readSampleTable(source);
  // The wait is known once the opening range reads have been answered, before the download starts.
  const policy = downloadPolicyFor(
    { size: bytes.byteLength, duration: table.duration, answerWait: resource.answerWait() },
    1,
  );
  const file = startFileDownload({ table, stream, codecs, policy });
  return { policy, file, rangesAsked: () => server.rangesAsked };
}

/**
 * The length named by a `bytes=first-last` header.
 */
function lengthOf(header: string): number {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header);
  if (!match) throw new Error(`not a byte range: ${header}`);
  return Number(match[2]) - Number(match[1]) + 1;
}

/**
 * The ranges the download (not the opening sample-table reads) asked for after `baseline`.
 */
function downloadRanges(opened: Opened, baseline: number): number[] {
  return opened
    .rangesAsked()
    .slice(baseline)
    .filter((range) => range.startsWith('bytes='))
    .map((range) => lengthOf(range));
}

/**
 * Drives the download's plans until one of its ranges is `expected` bytes, or the turns run out:
 * the instant-need range is small, but reading ahead tops up with a full request-sized range.
 */
async function waitForRequestSize(
  opened: Opened,
  baseline: number,
  expected: number,
): Promise<number[]> {
  for (let turn = 0; turn < 100; turn += 1) {
    const lengths = downloadRanges(opened, baseline);
    if (lengths.includes(expected)) return lengths;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return downloadRanges(opened, baseline);
}

describe('the observed answer wait reaches the download', () => {
  it('enlarges and thins the ranges a slow-to-answer server is asked for, end to end', async () => {
    // A 40 MiB, 4 s recording: its refill (a quarter of the 10 s budget) far exceeds 8 MiB, so a
    // slow server must ask for refill-sized ranges rather than the usual 8 MiB.
    const sampleBytes = MEBIBYTE;
    const { bytes, codecs } = downloadableFile(40, sampleBytes);
    const server = new RangeServer(bytes, { answerDelayMs: 300 });
    const opened = await openDownload(server, bytes, codecs);
    try {
      expect(opened.policy.requestSize).toBeGreaterThan(8 * MEBIBYTE);
      expect(opened.policy.requestsInFlight).toBe(3);
      const expected = opened.policy.requestSize;

      // Reading the first packet opens a cursor, which makes the download plan and ask for the
      // ranges it needs; the opening reads before this point are the sample-table lookup.
      const baseline = opened.rangesAsked().length;
      const packets = opened.file.videoTracks[0]!.packetsFrom(seconds(0))[Symbol.asyncIterator]();
      await packets.next();
      // Once playing reads ahead, a refill top-up is one request-sized range; the cursor stays
      // open (dispose ends it) so those plans actually run.
      opened.file.download.startReadingAhead();

      const lengths = await waitForRequestSize(opened, baseline, expected);
      expect(lengths).toContain(expected);
    } finally {
      opened.file.dispose();
    }
  }, 20_000);

  it('keeps the usual 8 MiB ranges, two at a time, against a server that answers quickly', async () => {
    const { bytes, codecs } = downloadableFile(40, MEBIBYTE);
    const server = new RangeServer(bytes);
    const opened = await openDownload(server, bytes, codecs);
    try {
      expect(opened.policy.requestSize).toBe(8 * MEBIBYTE);
      expect(opened.policy.requestsInFlight).toBe(2);

      const baseline = opened.rangesAsked().length;
      const packets = opened.file.videoTracks[0]!.packetsFrom(seconds(0))[Symbol.asyncIterator]();
      await packets.next();
      opened.file.download.startReadingAhead();

      const lengths = await waitForRequestSize(opened, baseline, 8 * MEBIBYTE);
      expect(lengths).toContain(8 * MEBIBYTE);
    } finally {
      opened.file.dispose();
    }
  }, 20_000);
});
