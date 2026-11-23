/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { VTTParser } from "../src";

// Two regions share the id "foo"; the one with lines:3 comes last and must win.
// A third region with id "bar" sits in between.
const HEADER = `WEBVTT

REGION
id:foo
lines:1

REGION
id:bar
lines:2

REGION
id:foo
lines:3

`;

function parseCues(body: string) {
    return new VTTParser(HEADER + body).cues;
}

function parseSingleCue(settings: string) {
    const cues = parseCues(`00:00:00.000 --> 00:00:01.000 ${settings}\ntext\n`);
    expect(cues).toHaveLength(1);
    return cues[0]!;
}

describe("WebVTT region binding", () => {
    it("binds a cue to the region with the matching id", () => {
        const cue = parseSingleCue("region:bar");
        expect(cue.region).not.toBeNull();
        expect(cue.region?.id).toBe("bar");
        expect(cue.region?.lines).toBe(2);
    });

    it("binds the last matching region when several regions share an id", () => {
        const cue = parseSingleCue("region:foo");
        expect(cue.region).not.toBeNull();
        expect(cue.region?.id).toBe("foo");
        expect(cue.region?.lines).toBe(3);
    });

    it("leaves the region null for an unknown id", () => {
        const cue = parseSingleCue("region:missing");
        expect(cue.region).toBeNull();
    });
});

describe("WebVTT explicit positioning drops the region", () => {
    it("drops the region for a valid numeric line setting", () => {
        const cue = parseSingleCue("region:foo line:5");
        expect(cue.line).toBe(5);
        expect(cue.snapToLines).toBe(true);
        expect(cue.region).toBeNull();
    });

    it("drops the region for a valid percentage line setting", () => {
        const cue = parseSingleCue("region:foo line:50%");
        expect(cue.line).toBe(50);
        expect(cue.snapToLines).toBe(false);
        expect(cue.region).toBeNull();
    });

    it("drops the region for a valid line setting with alignment", () => {
        const cue = parseSingleCue("region:foo line:25%,end");
        expect(cue.line).toBe(25);
        expect(cue.snapToLines).toBe(false);
        expect(cue.lineAlign).toBe("end");
        expect(cue.region).toBeNull();
    });

    it("drops the region for a valid size setting other than 100", () => {
        const cue = parseSingleCue("region:foo size:50%");
        expect(cue.size).toBe(50);
        expect(cue.region).toBeNull();
    });

    it("keeps the region for a size of 100%", () => {
        const cue = parseSingleCue("region:foo size:100%");
        expect(cue.size).toBe(100);
        expect(cue.region?.lines).toBe(3);
    });

    it("drops the region for a vertical writing direction", () => {
        const cue = parseSingleCue("region:foo vertical:rl");
        expect(cue.vertical).toBe("rl");
        expect(cue.region).toBeNull();
    });

    it("applies settings in order: a region setting after line re-binds the region", () => {
        const cue = parseSingleCue("line:5 region:foo");
        expect(cue.line).toBe(5);
        expect(cue.region?.lines).toBe(3);
    });
});

describe("WebVTT failed positioning settings preserve the region and defaults", () => {
    const invalidLineValues = [
        "line:abc",
        "line:1-",
        "line:1..5",
        "line:.5",
        "line:5.",
        "line:101%",
        "line:1%%",
        "line:%",
        "line:-",
        "line:100%,middle",
        "line:50%,startend",
    ];

    for (const value of invalidLineValues) {
        it(`keeps region, line and snapToLines for invalid ${value}`, () => {
            const cue = parseSingleCue(`region:foo ${value}`);
            expect(cue.region?.lines).toBe(3);
            expect(cue.line).toBe("auto");
            expect(cue.snapToLines).toBe(true);
        });
    }

    it("keeps the region and default size for an invalid size setting", () => {
        for (const value of ["size:abc", "size:101%", "size:-10%", "size:"]) {
            const cue = parseSingleCue(`region:foo ${value}`);
            expect(cue.region?.lines).toBe(3);
            expect(cue.size).toBe(100);
        }
    });

    it("keeps the region when an invalid line setting follows a valid region setting and vice versa", () => {
        const cue = parseSingleCue("region:foo line:bad size:bad");
        expect(cue.region?.lines).toBe(3);
        expect(cue.line).toBe("auto");
        expect(cue.size).toBe(100);
    });

    it("does not let a failed line setting undo an earlier valid size", () => {
        const cue = parseSingleCue("region:foo size:50% line:bad");
        expect(cue.size).toBe(50);
        expect(cue.line).toBe("auto");
        expect(cue.region).toBeNull();
    });
});

describe("WebVTT cue parsing independence", () => {
    it("does not leak positioning settings between consecutive cues", () => {
        const cues = parseCues(
            `00:00:00.000 --> 00:00:01.000 region:foo line:5 size:40%\nfirst\n\n` +
            `00:00:01.000 --> 00:00:02.000 region:foo\nsecond\n`
        );
        expect(cues).toHaveLength(2);
        expect(cues[0]!.line).toBe(5);
        expect(cues[0]!.size).toBe(40);
        expect(cues[0]!.region).toBeNull();
        // The second cue must be completely unaffected by the first cue's settings.
        expect(cues[1]!.region?.lines).toBe(3);
        expect(cues[1]!.line).toBe("auto");
        expect(cues[1]!.snapToLines).toBe(true);
        expect(cues[1]!.size).toBe(100);
    });

    it("does not let a broken settings line affect neighbouring cues", () => {
        const cues = parseCues(
            `00:00:00.000 --> 00:00:01.000 region:foo line:bad size:bad align:bad\nfirst\n\n` +
            `00:00:01.000 --> 00:00:02.000 region:bar\nsecond\n`
        );
        expect(cues).toHaveLength(2);
        expect(cues[0]!.region?.lines).toBe(3);
        expect(cues[0]!.line).toBe("auto");
        expect(cues[0]!.size).toBe(100);
        expect(cues[1]!.region?.lines).toBe(2);
        expect(cues[1]!.line).toBe("auto");
    });

    it("keeps cue text of consecutive cues separate", () => {
        const cues = parseCues(
            `00:00:00.000 --> 00:00:01.000\nfirst line\n\n` +
            `00:00:01.000 --> 00:00:02.000\nsecond line\n`
        );
        expect(cues).toHaveLength(2);
        expect(cues[0]!.text).toBe("first line");
        expect(cues[1]!.text).toBe("second line");
    });
});
