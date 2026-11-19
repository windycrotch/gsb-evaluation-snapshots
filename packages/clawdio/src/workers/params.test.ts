import { describe, expect, it } from "vitest";
import {
  PendingParams,
  outputsAreFinite,
  sanitizeInt,
  sanitizeNumber,
  silenceOutputs,
} from "./params";

describe("sanitizeNumber", () => {
  it("rejects NaN and +/-Infinity", () => {
    expect(sanitizeNumber(Number.NaN, { min: 0, max: 1 })).toBeNull();
    expect(
      sanitizeNumber(Number.POSITIVE_INFINITY, { min: 0, max: 1 }),
    ).toBeNull();
    expect(
      sanitizeNumber(Number.NEGATIVE_INFINITY, { min: 0, max: 1 }),
    ).toBeNull();
  });

  it("rejects non-number payloads", () => {
    expect(sanitizeNumber("0.5", { min: 0, max: 1 })).toBeNull();
    expect(sanitizeNumber(undefined, { min: 0, max: 1 })).toBeNull();
    expect(sanitizeNumber(null, { min: 0, max: 1 })).toBeNull();
  });

  it("clamps out-of-range values to the nearest boundary", () => {
    expect(sanitizeNumber(-4, { min: 0, max: 1 })).toBe(0);
    expect(sanitizeNumber(4, { min: 0, max: 1 })).toBe(1);
    expect(sanitizeNumber(0.25, { min: 0, max: 1 })).toBe(0.25);
  });
});

describe("sanitizeInt", () => {
  it("rejects non-finite values", () => {
    expect(sanitizeInt(Number.NaN, { min: 1, max: 16 })).toBeNull();
    expect(
      sanitizeInt(Number.POSITIVE_INFINITY, { min: 1, max: 16 }),
    ).toBeNull();
  });

  it("rounds before clamping", () => {
    expect(sanitizeInt(3.4, { min: 1, max: 16 })).toBe(3);
    expect(sanitizeInt(3.6, { min: 1, max: 16 })).toBe(4);
    expect(sanitizeInt(-99, { min: 1, max: 16 })).toBe(1);
    expect(sanitizeInt(99, { min: 1, max: 16 })).toBe(16);
  });
});

describe("PendingParams", () => {
  it("keeps only the latest value per parameter (last write wins)", () => {
    const pending = new PendingParams<"bits" | "normfreq">();
    pending.set("bits", 2);
    pending.set("bits", 8);
    pending.set("bits", 5);
    pending.set("normfreq", 0.4);

    expect(pending.get("bits")).toBe(5);
    expect(pending.get("normfreq")).toBe(0.4);
    expect(pending.size).toBe(2);

    pending.clear();
    expect(pending.size).toBe(0);
    expect(pending.get("bits")).toBeUndefined();
  });
});

describe("silenceOutputs / outputsAreFinite", () => {
  const makeOutputs = (): Float32Array[][] => [
    [Float32Array.from([0.1, 0.2, 0.3])],
    [Float32Array.from([-0.4, 0.5])],
  ];

  it("fills every channel with zeros", () => {
    const outputs = makeOutputs();
    silenceOutputs(outputs);
    outputs.forEach((channels) =>
      channels.forEach((channel) =>
        channel.forEach((sample) => expect(sample).toBe(0)),
      ),
    );
  });

  it("detects non-finite samples and accepts clean ones", () => {
    expect(outputsAreFinite(makeOutputs())).toBe(true);

    const dirty = makeOutputs();
    dirty[0][0][1] = Number.NaN;
    expect(outputsAreFinite(dirty)).toBe(false);

    const infinite = makeOutputs();
    infinite[1][0][0] = Number.POSITIVE_INFINITY;
    expect(outputsAreFinite(infinite)).toBe(false);
  });
});
