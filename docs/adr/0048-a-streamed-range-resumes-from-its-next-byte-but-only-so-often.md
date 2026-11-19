# ADR 0048: A streamed range resumes from its next byte, but only so often and for so long

Status: accepted (2026-11-20).

## Context

`HttpByteStream` already streamed one range in a single request and, when its body broke off or
brought no byte for the stall timeout, asked for the rest of the range from its next byte, under
the resource's own retry waits (ADR 0019). Two gaps remained for playing a remote recording over
a weak network:

- A connection that dropped, a gateway that answered 5xx for a while, or a server that slowed to
  a halt could be asked again without end. Each break-off opened another request; nothing bounded
  the number of resumes or the total time one range read could take, so a server that never
  recovered could hold the player in a resume loop instead of reporting the failure.
- It had to stay impossible to splice bytes of two versions of the file. The resource pins the
  version its first answer told of and rejects a later answer of another version with
  `source-changed` (ADR 0029); a resumed range goes through the same `rangeAnswer`, so the check
  had to keep applying to every resume, not just the first request.

The resource's `askingAgain` waits (250 ms, then 1 s) already bound a request that fails before
its answer. What was unbounded was the sequence of bodies after successful answers.

## Decision

`HttpByteStream` keeps one received-byte count per range and resumes from `offset + received`,
the byte after the last one handed to the reader, so the `Range` of every resumed request, the
count that picks its start, and the final whole-range check all describe the same bytes:

- **The first request is always made; only a body-level failure after the answer spends a
  resume.** A body that breaks off or stalls (a 206 whose stream errors or goes quiet for the
  stall timeout) drops the attempt and asks for the rest from the next received byte. A failure
  before the answer (a 5xx, a 429, an unreachable server) is retried on the resource's own waits
  for the same bytes and counts as no body resume, since it delivered no byte and the player
  already chose those waits for exactly this case.
- **The read is bounded two ways.** At most `maxResumes` (default 5) body resumes, and no longer
  than `maxReadMs` (default 60 s) in all, measured by an injected monotonic clock. Either limit
  reached ends the read with `source-unreadable` rather than opening another request. The
  resource's per-request waits still apply inside that budget.
- **Every answer is checked against the pinned version before its body is read**, including a
  resumed one. A recording replaced mid-stream is `source-changed` on the resume and its bytes are
  never joined to the old ones; because that error is not a passing failure, it is not retried or
  hidden by a resume. `range-unsupported` (a 200 to a range) and `cors` fail at once for the same
  reason.
- **Each range read owns its own count, attempts and cancellation.** Two ranges streamed at once
  keep separate `RangeReading` iterators, so one's received count, resume budget or `return()`
  never touches the other's; aborting a request ends only that iterator's fetch.

## Alternatives considered

- **Counting every attempt, including pre-answer retries, against the resume limit.** A server
  that 5xx'd twice and then dropped the connection would spend its budget on failures the
  resource's waits were already designed to absorb, failing a read that would otherwise recover.
  The budget now counts only resumes that follow bytes actually received.
- **One global resume budget for the whole download.** A long playback makes thousands of ranges;
  a fixed whole-download allowance would either be spent early or be too large to matter. The
  bound is per range, which is what can loop on a single dead connection.
- **Relying only on the stall timeout, with no count or total time.** A connection that breaks
  off cleanly (an immediate stream error, no quiet interval) is not caught by a stall timer, and a
  link that stalls just under the timeout repeatedly would resume for ever. The count and the
  total time close both holes.
- **Re-validating with a conditional (`If-Match`) request.** It would cost every range a CORS
  preflight and a server that supports conditional headers; reading the version the answer itself
  names needs no extra request (ADR 0029).

## Consequences

A single dropped connection or a run of slow/stalled answers resumes from the next byte and still
completes the range whole, with no byte repeated or skipped. A server that keeps failing is given
up after five body resumes or 60 s, whichever comes first, and the failure keeps its code so the
host can distinguish a network that is gone from a replaced file. The defaults recover every
brief outage while bounding the worst case to about a minute per range; tests drive the limits
with injected clocks and self-made `Response`/`ReadableStream` objects, so no real network or
timing is relied on.
