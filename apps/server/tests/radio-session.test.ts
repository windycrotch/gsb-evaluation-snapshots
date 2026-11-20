import { expect, test } from "vite-plus/test";
import { StationSession } from "../src/radio/session.ts";

test("a session counts its listeners and forgets the title only once they're all gone", () => {
  const session = new StationSession();
  expect(session.listenerCount).toBe(0);
  expect(session.title).toBeNull();

  const a = session.attach();
  const b = session.attach();
  expect(session.listenerCount).toBe(2);

  session.setTitle(a, "Band - Song");
  expect(session.title).toBe("Band - Song");
  // One connection going away only decrements: the station's song stays for the other.
  session.detach(a);
  expect(session.listenerCount).toBe(1);
  expect(session.title).toBe("Band - Song");

  // The gone connection can't take the title back.
  session.setTitle(a, "Stale - Old Song");
  expect(session.title).toBe("Band - Song");

  // The connection that's still listening can update it.
  session.setTitle(b, "Band - Next Song");
  expect(session.title).toBe("Band - Next Song");

  // Last listener gone: the next listener must not read this session's song.
  session.detach(b);
  expect(session.listenerCount).toBe(0);
  expect(session.title).toBeNull();
});

test("a recycled session starts clean and never lets a detached connection write back", () => {
  const session = new StationSession();
  const first = session.attach();
  session.setTitle(first, "Old - Tune");
  session.detach(first);

  const next = session.attach();
  expect(session.title).toBeNull();
  // A late callback from the old connection is ignored.
  session.setTitle(first, "Old - Tune");
  expect(session.title).toBeNull();

  session.setTitle(next, "New - Tune");
  expect(session.title).toBe("New - Tune");
});

test("detaching is idempotent and titles can be cleared to null", () => {
  const session = new StationSession();
  const a = session.attach();
  session.setTitle(a, "A - B");
  session.detach(a);
  session.detach(a);
  expect(session.listenerCount).toBe(0);
  expect(session.title).toBeNull();

  const b = session.attach();
  session.setTitle(b, null);
  expect(session.title).toBeNull();
});
