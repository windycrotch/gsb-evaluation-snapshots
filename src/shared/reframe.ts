import type { Crop, Shape } from "./crop";
import { keepEdgeFades, type SplittableClip } from "./split";

export type Layout = "whole" | "speaker" | "split";
export type Shot = { from: number; to: number; layout: Layout; reason: string; review: boolean;
  subjects: { label: string; region: Crop }[]; top?: Crop; bottom?: Crop };
export type SplitFrame = { top: Crop; bottom: Crop };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** A clock as the model writes it: H:MM:SS.mmm, M:SS.mmm, or plain seconds. */
export function sourceTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const m = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(v);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
export function validCrop(c: any): c is Crop {
  return !!c && [c.x,c.y,c.width,c.height].every(Number.isFinite) && c.x >= 0 && c.y >= 0 &&
    c.width >= .01 && c.height >= .01 && c.x+c.width <= 1.0001 && c.y+c.height <= 1.0001;
}
/** Enclose the observed subject, add breathing room, then fit inside the source. */
export function focusCrop(region: Crop, shape: Shape, ratio: number): Crop {
  const aspect = ratio * shape.height / shape.width;
  let h = Math.max(region.height * 1.25, region.width * 1.25 / aspect), w = h * aspect;
  const scale = Math.min(1, 1 / w, 1 / h); w *= scale; h *= scale;
  return { x: clamp(region.x + region.width / 2 - w / 2, 0, 1-w),
    y: clamp(region.y + region.height / 2 - h / 2, 0, 1-h), width: w, height: h };
}
const fallback = (from: number, to: number, reason: string): Shot => ({ from, to, layout: "whole", reason, review: true, subjects: [] });
/** Model advice is untrusted. Bad clocks, gaps and uncertain regions keep the whole picture. */
export function normalizeShots(value: unknown, start: number, end: number, shape: Shape): Shot[] {
  const raw = (value as any)?.shots;
  if (!Array.isArray(raw) || raw.length > 40) return [fallback(start,end,"Framing needs manual review.")];
  const out: Shot[] = []; let at = start;
  const parsed = raw.map(s=>({s,from:sourceTime(s?.from),to:sourceTime(s?.to)}))
    .filter(v=>v.from !== null && v.to !== null && v.to > v.from);
  const inside = (v:{from:number|null;to:number|null}) => v.from! >= start-.1 && v.to! <= end+.1;
  // An answer counted from the start of the stretch, not the whole video (asked for, not
  // always given): every shot outside the stretch but inside its length. A mixed answer
  // is not shifted; its stray shots are dropped like any other.
  const relative = start > .1 && parsed.length > 0 && !parsed.some(inside) && parsed.every(v=>v.to! <= end-start+.1);
  const sorted = parsed.map(v=>relative ? {...v,from:v.from!+start,to:v.to!+start} : v)
    .filter(inside).sort((a,b)=>a.from!-b.from!);
  for (const {s,from,to} of sorted) {
    const lo = Math.max(at,from!), hi = Math.min(end,to!);
    if (hi-lo < .1) continue;
    if (lo-at > .1) out.push(fallback(at,lo,"No reliable framing for this section."));
    const subjects: Shot["subjects"] = Array.isArray(s.subjects) ? s.subjects.filter((p:any)=>validCrop(p?.region) && typeof p.label === "string")
      .slice(0,3).map((p:any)=>({label:p.label.slice(0,100),region:p.region as Crop})) : [];
    let layout: Layout = s.confidence === "high" && ["speaker","split","whole"].includes(s.layout) ? s.layout : "whole";
    if ((layout === "speaker" && subjects.length < 1) || (layout === "split" && subjects.length < 2)) layout = "whole";
    const contains = (c:Crop,r:Crop) => c.x <= r.x+.001 && c.y <= r.y+.001 && c.x+c.width >= r.x+r.width-.001 && c.y+c.height >= r.y+r.height-.001;
    if(layout !== "whole" && subjects.slice(0,layout === "split"?2:1).some(p=>!contains(focusCrop(p.region,shape,layout === "split"?9/8:9/16),p.region))) layout="whole";
    const review = layout === "whole" || s.confidence !== "high";
    out.push({from:out.length ? out[out.length-1].to : start,to:hi,layout,subjects,review,
      reason:typeof s.reason === "string" ? s.reason.slice(0,400) : "Review the framing.",
      ...(subjects[0] ? {top:focusCrop(subjects[0].region,shape,layout === "split" ? 9/8 : 9/16)} : {}),
      ...(subjects[1] ? {bottom:focusCrop(subjects[1].region,shape,9/8)} : {})});
    at = hi;
  }
  if (end-at > .001) out.push(fallback(at,end,"No reliable framing for this section."));
  return out.length ? out : [fallback(start,end,"Framing needs manual review.")];
}
/** Advice uses source time; edits use whole output frames. Never change the clip's length. */
export function framedPieces<T extends SplittableClip & { crop?: Crop; split?: SplitFrame; fit?: "cover" | "contain"; anchor?: {x:number;y:number} }>(
  clip: T, duration: number, fps: number, shots: Shot[], id: () => string,
): T[] {
  const start = clip.trimStart ?? 0, frames = Math.max(1,Math.round(duration*fps));
  const minimum = Math.ceil(.05 * fps);
  const cuts = [0];
  for (const n of [...new Set(shots.flatMap(s=>[s.from,s.to]).map(t=>clamp(Math.round((t-start)*fps),0,frames)))].sort((a,b)=>a-b)) {
    if (n-cuts[cuts.length-1] >= minimum && frames-n >= minimum) cuts.push(n);
  }
  cuts.push(frames);
  const pieces: T[] = [];
  for (let i=0;i<cuts.length-1;i++) {
    const a=cuts[i], b=cuts[i+1];
    const middle=start+(a+b)/2/fps;
    const shot=shots.find(s=>middle>=s.from && middle<s.to);
    const piece:T = {...clip,id:pieces.length ? id() : clip.id,trimStart:start+a/fps,duration:Math.max(.05,(b-a)/fps),fit:"contain"};
    delete piece.trimEnd; delete piece.crop; delete piece.anchor; delete piece.split;
    if(shot?.layout === "speaker" && validCrop(shot.top)){piece.crop=shot.top;piece.fit="cover";}
    if(shot?.layout === "split" && validCrop(shot.top) && validCrop(shot.bottom)) piece.split={top:shot.top,bottom:shot.bottom};
    pieces.push(piece);
  }
  keepEdgeFades(pieces); return pieces;
}

/**
 * The stretches a clip is read in. The analysis route takes at most five
 * minutes at a time (server/reframe.ts), so a longer clip is cut into equal
 * parts a little under that: rounding a boundary never pushes one over.
 * Contiguous, in order, covering `start`..`end`.
 */
export function analysisWindows(start: number, end: number, max = 299.5): { from: number; to: number }[] {
  const n = Math.max(1, Math.ceil((end - start) / max - 1e-9));
  const at = (i: number) => (i === n ? end : Math.round((start + ((end - start) * i) / n) * 1000) / 1000);
  return Array.from({ length: n }, (_, i) => ({ from: at(i), to: at(i + 1) }));
}

/** Statuses that mean an analysis is still in flight, so the part must not be re-submitted. */
export const BUSY_STATUSES = ["starting", "running", "preparing"] as const;

/** One stretch of a clip, analysed on its own (analysisWindows), wherever that analysis runs. */
export type AnalysisPart = { from: number; to: number; id?: string; status: string; error?: string; shots?: Shot[] };

/** A framing answer as POST /api/reframe and GET /api/reframe/:id report it. */
export type FramingResult = { id?: string; status: string; shots?: Shot[] | null; error?: string | null };

const partFallback = (from: number, to: number, reason: string): Shot => ({
  from, to, layout: "whole", reason, review: true, subjects: [],
});
/** Same clock slack normalizeShots allows: a shot touching the window edge counts as inside. */
const EDGE = 0.1;
/** Too short to keep as its own shot once rounded onto the window edges. */
const MIN_SHOT = 0.1;

/**
 * Join the shot lists of consecutive analysis windows into one sequence that
 * covers the whole clip exactly once: no holes and no overlapping time.
 *
 * Each window's shots were normalised inside its own [from,to] by the server,
 * so the boundary shots of two touching windows meet at the same instant and
 * both are kept — they are distinct shots that only share a boundary. A shot
 * the model returned outside every window is dropped (normalizeShots' rule),
 * and anything a window leaves uncovered is filled with a reviewable whole
 * shot, the same fallback normalizeShots uses.
 */
export function mergeWindowShots(
  windows: { from: number; to: number; shots?: Shot[] }[],
  start: number,
  end: number,
): Shot[] {
  if (!(end > start)) return [];
  const ordered = [...windows].filter(w => w.to > w.from).sort((a, b) => a.from - b.from);
  const out: Shot[] = [];
  let at = start;
  const fillTo = (t: number) => {
    if (t - at > EDGE) out.push(partFallback(at, t, "No reliable framing for this section."));
    at = t;
  };
  for (const w of ordered) {
    if (w.to <= at - EDGE) continue; // an out-of-order/duplicate window, fully consumed
    if (w.from > at + EDGE) fillTo(Math.min(w.from, end)); // a window missing from the answer: keep the picture whole
    if (at >= end) break;
    for (const raw of w.shots ?? []) {
      // normalizeShots' rule: a clock outside the window (past the edge slack)
      // is dropped, not pulled back in. The gap it leaves is filled whole below.
      if (raw.from < w.from - EDGE || raw.to > w.to + EDGE || raw.to <= raw.from) continue;
      // Inside the window: clamp onto what is still uncovered and the clip's end.
      // The same edge slack applies here, so a shot a few ms past the boundary
      // keeps its clock instead of being snapped and duplicated by the neighbour.
      const lo = Math.max(at, raw.from), hi = Math.min(end, raw.to);
      if (hi - lo < MIN_SHOT) continue;
      fillTo(lo);
      out.push({ ...raw, from: at, to: hi });
      at = hi;
    }
    if (at < w.to - EDGE) fillTo(Math.min(w.to, end)); // the window answered but left a gap inside itself
  }
  fillTo(end);
  return out.length ? out : [partFallback(start, end, "Framing needs manual review.")];
}

/** What one refresh of the analysis parts should do with a single part. */
export type PartRequest =
  | { action: "skip" }
  | { action: "post"; retry: boolean }
  | { action: "get"; id: string };

/**
 * Decide, without looking at other parts, how one window's analysis is driven
 * this round. A finished part is never submitted again, and a failure is only
 * restarted when `retry` is asked for explicitly: reusing a completed window
 * and retrying a failed one therefore never touch each other. A poll round
 * checks the in-flight rows (GET starts no analysis); an analyze round leaves
 * them for the poll already running.
 */
export function partRequest(part: AnalysisPart, retry: boolean, poll = false): PartRequest {
  if (part.status === "done") return { action: "skip" };
  if (BUSY_STATUSES.includes(part.status as (typeof BUSY_STATUSES)[number])) {
    if (!poll || !part.id) return { action: "skip" };
    return { action: "get", id: part.id };
  }
  // The server said the analysis itself failed: only an explicit retry starts
  // a new one, and it goes through POST so the server can replace the row.
  if (part.status === "failed") return retry ? { action: "post", retry: true } : { action: "skip" };
  // A request that never answered (client-side error). Re-check the row we
  // already hold before ever starting another analysis; with no row there is
  // nothing to read, so the first round posts (and a later round retries).
  if (part.status === "error") {
    if (part.id) return { action: "get", id: part.id };
    return retry ? { action: "post", retry: true } : { action: "post", retry: false };
  }
  if (part.id) return { action: "get", id: part.id };
  return { action: "post", retry: false };
}

/**
 * Drive every window's analysis one round. Parts that are done or (outside a
 * poll) in flight are returned untouched and never asked for again; only the
 * parts this round actually targets issue a request, so a failed window
 * retries on its own and the completed windows keep their shots.
 */
export async function refreshParts(
  parts: AnalysisPart[],
  retry: boolean,
  call: {
    post: (part: AnalysisPart, retry: boolean) => Promise<FramingResult>;
    get: (id: string) => Promise<FramingResult>;
    fail: (part: AnalysisPart, message: string) => string;
  },
  poll = false,
): Promise<AnalysisPart[]> {
  return Promise.all(parts.map(async part => {
    const req = partRequest(part, retry, poll);
    if (req.action === "skip") return part;
    try {
      const r = req.action === "get" ? await call.get(req.id) : await call.post(part, req.retry);
      return {
        ...part,
        id: r.id ?? part.id,
        status: r.status,
        error: r.error ?? undefined,
        shots: r.shots ?? part.shots,
      };
    } catch (e) {
      return { ...part, status: "error", error: call.fail(part, (e as Error).message) };
    }
  }));
}
