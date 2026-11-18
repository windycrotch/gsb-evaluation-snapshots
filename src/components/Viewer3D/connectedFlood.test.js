import { describe, it, expect } from "vitest";
import { computeConnectedFlood } from "./connectedFlood";

function hm(width, height, values) {
  return { elevations: Float32Array.from(values), width, height };
}

function flat(width, height, value) {
  const elevations = new Float32Array(width * height);
  elevations.fill(value);
  return { elevations, width, height };
}

/** 5x5 with a high rim and a low 3x3 pit in the middle. */
function walledPit() {
  const w = 5;
  const h = 5;
  const values = new Array(w * h).fill(100);
  for (let r = 1; r < 4; r++) {
    for (let c = 1; c < 4; c++) values[r * w + c] = 0;
  }
  return hm(w, h, values);
}

describe("computeConnectedFlood", () => {
  it("counts every cell of a low flat heightmap as connected", () => {
    const res = computeConnectedFlood(flat(4, 3, 5), 10, 2);
    expect(res.connectedCount).toBe(12);
    expect(res.connectedAreaM2).toBe(24);
    expect(res.enclosedCount).toBe(0);
    expect(res.floodedFraction).toBeCloseTo(1, 10);
    expect(res.connected.every(Boolean)).toBe(true);
  });

  it("does not count low ground walled in by higher terrain", () => {
    const res = computeConnectedFlood(walledPit(), 10, 1);
    expect(res.connectedCount).toBe(0);
    expect(res.connectedAreaM2).toBe(0);
    expect(res.enclosedCount).toBe(9);
    expect(res.floodedFraction).toBe(0);
    // Only the rim is above water; the pit cells stay dry.
    for (let r = 1; r < 4; r++) {
      for (let c = 1; c < 4; c++) {
        expect(res.connected[r * 5 + c]).toBe(false);
      }
    }
  });

  it("counts cells whose elevation equals the water level exactly", () => {
    const heightmap = hm(3, 3, [
      5, 5, 5,
      5, 10, 5,
      5, 5, 5,
    ]);
    const res = computeConnectedFlood(heightmap, 10, 1);
    // The centre sits exactly at the level and touches the flooded border.
    expect(res.connectedCount).toBe(9);
    expect(res.connected[4]).toBe(true);
    expect(res.enclosedCount).toBe(0);
  });

  it("returns all-zero stats for an empty heightmap", () => {
    const res = computeConnectedFlood(
      { elevations: new Float32Array(0), width: 0, height: 0 },
      10,
      1,
    );
    expect(res.connectedCount).toBe(0);
    expect(res.connectedAreaM2).toBe(0);
    expect(res.enclosedCount).toBe(0);
    expect(res.floodedFraction).toBe(0);
    expect(Number.isNaN(res.floodedFraction)).toBe(false);
    expect(res.connected).toEqual([]);
  });

  it("returns zero when the level is below the global minimum", () => {
    const res = computeConnectedFlood(flat(4, 4, 100), 99, 1);
    expect(res.connectedCount).toBe(0);
    expect(res.floodedFraction).toBe(0);
    expect(res.enclosedCount).toBe(0);
  });

  it("does not seed from border cells above the water level", () => {
    const heightmap = hm(4, 4, [
      100, 100, 100, 100,
      100, 0, 0, 100,
      100, 0, 0, 100,
      100, 100, 100, 100,
    ]);
    const res = computeConnectedFlood(heightmap, 50, 1);
    expect(res.connectedCount).toBe(0);
    expect(res.enclosedCount).toBe(4);
  });

  it("spreads through a low channel to reach an inner basin", () => {
    const heightmap = hm(5, 3, [
      100, 100, 100, 100, 100,
      0, 0, 0, 0, 0,
      100, 100, 100, 100, 100,
    ]);
    const res = computeConnectedFlood(heightmap, 50, 10);
    expect(res.connectedCount).toBe(5);
    expect(res.connectedAreaM2).toBe(50);
    expect(res.floodedFraction).toBeCloseTo(5 / 15, 10);
  });
});
