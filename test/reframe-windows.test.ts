import { describe, expect, it, vi } from "vitest";
import {
  analysisWindows,
  mergeWindowShots,
  partRequest,
  refreshParts,
  type AnalysisPart,
  type FramingResult,
  type Shot,
} from "../src/shared/reframe";

const shot = (from: number, to: number, layout: Shot["layout"] = "speaker"): Shot => ({
  from, to, layout, reason: "test shot", review: layout !== "speaker",
  subjects: layout === "whole" ? [] : [{ label: "speaker", region: { x: 0.4, y: 0.1, width: 0.2, height: 0.6 } }],
});
const whole = (from: number, to: number): Shot => ({ ...shot(from, to, "whole"), review: true });
const part = (from: number, to: number, status = "idle", extra: Partial<AnalysisPart> = {}): AnalysisPart =>
  ({ from, to, status, ...extra });

describe("merging analysis windows into one timeline", () => {
  it("joins the windows of a long clip into a continuous, non-overlapping sequence", () => {
    const start = 0, end = 1506.16;
    const windows = analysisWindows(start, end);
    expect(windows.length).toBeGreaterThan(1);
    const parts: AnalysisPart[] = windows.map((w) => part(w.from, w.to, "done", {
      id: `job-${w.from}`,
      shots: [shot(w.from, (w.from + w.to) / 2), shot((w.from + w.to) / 2, w.to)],
    }));
    const merged = mergeWindowShots(parts, start, end);
    // No holes: every instant of the clip belongs to exactly one shot.
    expect(merged[0].from).toBeCloseTo(start, 6);
    expect(merged.at(-1)!.to).toBeCloseTo(end, 6);
    for (let i = 1; i < merged.length; i++) expect(merged[i].from).toBeCloseTo(merged[i - 1].to, 6);
    // No overlaps and no backwards time anywhere.
    for (let i = 1; i < merged.length; i++) expect(merged[i].from).toBeGreaterThanOrEqual(merged[i - 1].to - 1e-9);
  });

  it("keeps both shots where two touching windows meet at the boundary", () => {
    // Window A ends at 300 exactly where window B begins: two distinct shots
    // share only the boundary instant, so both survive the join.
    const parts = [
      part(0, 300, "done", { shots: [shot(0, 150), shot(150, 300)] }),
      part(300, 600, "done", { shots: [shot(300, 450), shot(450, 600)] }),
    ];
    const merged = mergeWindowShots(parts, 0, 600);
    expect(merged.map((s) => [s.from, s.to])).toEqual([[0, 150], [150, 300], [300, 450], [450, 600]]);
  });

  it("fills a gap left inside a window with a reviewable whole shot, instead of a hole", () => {
    // The model answered only the first half of window B; normalizeShots would
    // itself fill this, but the merge must guarantee coverage even if it did not.
    const parts = [
      part(0, 300, "done", { shots: [shot(0, 300)] }),
      part(300, 600, "done", { shots: [shot(420, 600)] }),
    ];
    const merged = mergeWindowShots(parts, 0, 600);
    expect(merged.map((s) => [s.from, s.to, s.layout])).toEqual([
      [0, 300, "speaker"],
      [300, 420, "whole"],
      [420, 600, "speaker"],
    ]);
    expect(merged[1].review).toBe(true);
  });

  it("drops shots the model returned outside the window and whole-fills what they leave", () => {
    const parts = [
      part(0, 300, "done", { shots: [shot(0, 300)] }),
      // A clock counted from the wrong origin: 0..60 belongs to the previous window.
      part(300, 600, "done", { shots: [shot(0, 60), shot(360, 600)] }),
    ];
    const merged = mergeWindowShots(parts, 0, 600);
    expect(merged.every((s) => s.from >= 0 - 1e-9 && s.to <= 600 + 1e-9)).toBe(true);
    expect(merged.map((s) => [s.from, s.to])).toEqual([[0, 300], [300, 360], [360, 600]]);
    expect(merged[1].layout).toBe("whole");
  });

  it("covers the full clip when a window's answer is empty", () => {
    const parts = [
      part(0, 300, "done", { shots: [] }),
      part(300, 600, "done", { shots: [shot(300, 600)] }),
    ];
    const merged = mergeWindowShots(parts, 10, 590);
    expect(merged[0]).toMatchObject({ from: 10, to: 300, layout: "whole" });
    expect(merged.at(-1)).toMatchObject({ to: 590 });
  });

  it("covers a clip that starts part-way through the source clock", () => {
    const windows = analysisWindows(510, 510 + 1506.16);
    const parts: AnalysisPart[] = windows.map((w) => part(w.from, w.to, "done", { shots: [shot(w.from, w.to)] }));
    const merged = mergeWindowShots(parts, 510, 510 + 1506.16);
    expect(merged[0].from).toBeCloseTo(510, 6);
    expect(merged.at(-1)!.to).toBeCloseTo(510 + 1506.16, 6);
    for (let i = 1; i < merged.length; i++) expect(merged[i].from).toBeCloseTo(merged[i - 1].to, 6);
  });

  it("keeps shots that only straddle a window edge by the normalize slack", () => {
    // normalizeShots accepts a clock 0.1s past the window edge; the merge must too.
    const parts = [
      part(0, 300, "done", { shots: [shot(0, 300.05)] }),
      part(300, 600, "done", { shots: [shot(299.95, 600)] }),
    ];
    const merged = mergeWindowShots(parts, 0, 600);
    expect(merged[0].to).toBe(300.05);
    // The 50 ms past the edge is not duplicated: the next shot starts where coverage stands.
    expect(merged[1].from).toBe(300.05);
    expect(merged.at(-1)!.to).toBe(600);
  });

  it("returns a whole-shot fallback for an empty window set rather than an empty timeline", () => {
    const merged = mergeWindowShots([], 10, 50);
    expect(merged).toEqual([{
      from: 10, to: 50, layout: "whole", reason: "No reliable framing for this section.",
      review: true, subjects: [],
    }]);
  });

  it("does not let a window past the clip end extend the timeline", () => {
    const parts = [
      part(0, 300, "done", { shots: [shot(0, 300)] }),
      part(300, 400, "done", { shots: [shot(300, 400)] }),
    ];
    const merged = mergeWindowShots(parts, 0, 350);
    expect(merged.at(-1)!.to).toBe(350);
    expect(merged.reduce((n, s) => n + (s.to - s.from), 0)).toBeCloseTo(350, 6);
  });
});

describe("driving the windows one round at a time", () => {
  const deps = (posts: Array<AnalysisPart & { retry?: boolean }> = [], gets: string[] = []) => ({
    post: vi.fn(async (p: AnalysisPart, retry: boolean): Promise<FramingResult> => {
      posts.push({ ...p, retry });
      return { id: `job-${p.from}`, status: "running" };
    }),
    get: vi.fn(async (id: string): Promise<FramingResult> => {
      gets.push(id);
      return { id, status: "running" };
    }),
    fail: vi.fn((_p: AnalysisPart, message: string) => message),
  });

  it("starts every idle window once and leaves started windows alone on the next round", async () => {
    const posts: Array<AnalysisPart & { retry?: boolean }> = [];
    const d = deps(posts);
    let parts = [part(0, 300), part(300, 600), part(600, 900)];
    parts = await refreshParts(parts, false, d);
    expect(d.post).toHaveBeenCalledTimes(3);
    expect(posts.every((p) => p.retry === false)).toBe(true);
    expect(parts.every((p) => p.status === "running")).toBe(true);
    // A poll round: running parts are checked, never re-submitted.
    const gets: string[] = [];
    const pollDeps = deps([], gets);
    const again = await refreshParts(parts, false, pollDeps, true);
    expect(pollDeps.post).not.toHaveBeenCalled();
    expect(gets).toHaveLength(3);
    expect(again.every((p) => p.status === "running")).toBe(true);
  });

  it("never submits a part that is already in flight, even when rounds overlap", async () => {
    // Simulate two clicks whose rounds interleave against the same state: the
    // first round starts both windows, and every later round only reads them.
    const initial = [part(0, 300), part(300, 600)];
    const posts: Array<AnalysisPart & { retry?: boolean }> = [];
    const started = await refreshParts(initial, false, deps(posts));
    expect(posts).toHaveLength(2);
    // A second click arriving after the parts turned running: an analyze round
    // skips them, a poll round only GETs their rows. No POST ever goes out.
    const morePosts: Array<AnalysisPart & { retry?: boolean }> = [];
    const gets: string[] = [];
    const later = deps(morePosts, gets);
    const [analyzed, polled] = await Promise.all([
      refreshParts(started, false, later),
      refreshParts(started, false, later, true),
    ]);
    expect(morePosts).toHaveLength(0);
    expect(gets).toHaveLength(2); // only the poll round checks, once per window
    expect(analyzed.every((p) => p.status === "running")).toBe(true);
    expect(polled.every((p) => p.status === "running")).toBe(true);
  });

  it("retries only the failed window and keeps every completed window's shots", async () => {
    const keep = whole(0, 300);
    const parts: AnalysisPart[] = [
      part(0, 300, "done", { id: "job-0", shots: [keep] }),
      part(300, 600, "failed", { id: "job-300", error: "lost submission" }),
      part(600, 900, "done", { id: "job-600", shots: [shot(600, 900)] }),
    ];
    const posts: Array<AnalysisPart & { retry?: boolean }> = [];
    const gets: string[] = [];
    const d = deps(posts, gets);
    const next = await refreshParts(parts, true, d);
    // Only the failed window generated a request, and it was an explicit retry.
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(posts[0].from).toBe(300);
    expect(posts[0].retry).toBe(true);
    expect(d.get).not.toHaveBeenCalled();
    // The completed windows came back byte-for-byte, shots included.
    expect(next[0]).toBe(parts[0]);
    expect(next[2]).toBe(parts[2]);
    expect(next[0].shots).toEqual([keep]);
    // A non-retry round after the same failure must not restart anything.
    const quiet = await refreshParts(parts, false, deps());
    expect(quiet[1]).toBe(parts[1]);
  });

  it("retrying one failed window of a long clip leaves the finished timeline intact", async () => {
    // Three windows, as a >10-minute clip would produce: the middle one failed
    // after the outer two came back done.
    const parts: AnalysisPart[] = [
      part(0, 300, "done", { id: "job-0", shots: [shot(0, 300)] }),
      part(300, 600, "failed", { id: "job-300", error: "Video analysis failed" }),
      part(600, 900, "done", { id: "job-600", shots: [shot(600, 900)] }),
    ];
    const posts: Array<AnalysisPart & { retry?: boolean }> = [];
    const next = await refreshParts(parts, true, deps(posts, []));
    expect(posts).toHaveLength(1);
    expect(posts[0].from).toBe(300);
    expect(posts[0].retry).toBe(true);
    // The finished windows keep their analyses and are never re-submitted.
    expect(next[0]).toBe(parts[0]);
    expect(next[2]).toBe(parts[2]);
    expect(next[1].status).toBe("running");
    // Once the retried window finishes, the merged timeline is continuous again.
    const settled: AnalysisPart[] = next.map((p, i) => i === 1 ? part(300, 600, "done", { id: "job-300b", shots: [shot(300, 600)] }) : p);
    const merged = mergeWindowShots(settled, 0, 900);
    expect(merged.map((s) => [s.from, s.to])).toEqual([[0, 300], [300, 600], [600, 900]]);
  });

  it("marks only the window whose request failed and never touches the others", async () => {
    const parts: AnalysisPart[] = [
      part(0, 300, "idle"),
      part(300, 600, "idle"),
    ];
    const d = {
      post: vi.fn(async (p: AnalysisPart) => {
        if (p.from === 300) throw new Error("network down");
        return { id: `job-${p.from}`, status: "running" } as FramingResult;
      }),
      get: vi.fn(),
      fail: vi.fn((_p: AnalysisPart, message: string) => message),
    };
    const next = await refreshParts(parts, false, d);
    expect(next[0].status).toBe("running");
    expect(next[0].id).toBe("job-0");
    expect(next[1].status).toBe("error");
    expect(next[1].error).toBe("network down");
    // A poll re-checks the running window; the error window without a row re-posts,
    // but never with the server-side retry flag that would discard an analysis.
    const gets: string[] = [];
    const d2 = {
      post: vi.fn(async (p: AnalysisPart, retry: boolean): Promise<FramingResult> => {
        expect(retry).toBe(false);
        return { id: "job-300-new", status: "starting" };
      }),
      get: vi.fn(async (id: string): Promise<FramingResult> => { gets.push(id); return { id, status: "done", shots: [shot(0, 300)] }; }),
      fail: vi.fn((_p: AnalysisPart, m: string) => m),
    };
    const after = await refreshParts(next, false, d2, true);
    expect(d2.post).toHaveBeenCalledTimes(1);
    expect(gets).toEqual(["job-0"]);
    expect(after[0].status).toBe("done");
    expect(after[1].status).toBe("starting");
  });

  it("re-checks an error with a known id instead of starting a new analysis", () => {
    expect(partRequest(part(0, 300, "error", { id: "job-x" }), false)).toEqual({ action: "get", id: "job-x" });
    expect(partRequest(part(0, 300, "error", { id: "job-x" }), true)).toEqual({ action: "get", id: "job-x" });
    expect(partRequest(part(0, 300, "failed", { id: "job-x" }), false)).toEqual({ action: "skip" });
    expect(partRequest(part(0, 300, "failed", { id: "job-x" }), true)).toEqual({ action: "post", retry: true });
    expect(partRequest(part(0, 300, "error"), false)).toEqual({ action: "post", retry: false });
    expect(partRequest(part(0, 300, "error"), true)).toEqual({ action: "post", retry: true });
    expect(partRequest(part(0, 300, "done", { shots: [] }), true)).toEqual({ action: "skip" });
    expect(partRequest(part(0, 300, "running", { id: "job-x" }), true)).toEqual({ action: "skip" });
    expect(partRequest(part(0, 300, "running", { id: "job-x" }), false, true)).toEqual({ action: "get", id: "job-x" });
    // "preparing" has no row yet: nothing to GET, and nothing to re-submit.
    expect(partRequest(part(0, 300, "preparing"), false, true)).toEqual({ action: "skip" });
    expect(partRequest(part(0, 300, "idle"), false)).toEqual({ action: "post", retry: false });
  });
});
