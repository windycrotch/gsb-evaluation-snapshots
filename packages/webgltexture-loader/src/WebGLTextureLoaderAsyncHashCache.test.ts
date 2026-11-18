import WebGLTextureLoaderAsyncHashCache from "./WebGLTextureLoaderAsyncHashCache.js";
import type { TextureAndSize } from "./WebGLTextureLoader.js";

const mockGL = (deleted: WebGLTexture[] = []) =>
  ({
    deleteTexture: (t: WebGLTexture) => {
      deleted.push(t);
    },
  }) as unknown as WebGLRenderingContext;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const textureWithId = (id: number) => ({ id }) as unknown as WebGLTexture;

/** Resolves on the next macrotask so queued promise callbacks have run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Reports whether `p` settles before a short timeout. */
function settleState(p: Promise<unknown>): Promise<"resolved" | "rejected" | "timeout"> {
  return Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"timeout">((resolve) => setTimeout(resolve, 10, "timeout")),
  ]);
}

/**
 * Fake async loader whose loadNoCache promises can be resolved or rejected
 * on demand, one attempt at a time.
 */
class FakeLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  loadNoCacheCalls = 0;
  disposeCalls = 0;
  pending: Deferred<TextureAndSize>[] = [];

  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(_input: number) {
    this.loadNoCacheCalls++;
    const d = deferred<TextureAndSize>();
    this.pending.push(d);
    return {
      promise: d.promise,
      dispose: () => {
        this.disposeCalls++;
      },
    };
  }

  resolveAttempt(index: number, textureId: number) {
    this.pending[index].resolve({ texture: textureWithId(textureId), width: 2, height: 2 });
  }
  rejectAttempt(index: number, reason: unknown) {
    this.pending[index].reject(reason);
  }
}

test("load resolves and get returns the same value afterwards", async () => {
  const loader = new FakeLoader(mockGL());
  const p = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.resolveAttempt(0, 42);
  const res = await p;
  expect(res).toMatchObject({ width: 2, height: 2 });
  expect(loader.get(42)).toBe(res);
  expect(loader.get(43)).toBeUndefined();
  loader.dispose();
});

test("load is idempotent: concurrent loads of the same input share one Promise", () => {
  const loader = new FakeLoader(mockGL());
  const p1 = loader.load(42);
  const p2 = loader.load(42);
  expect(p1).toBe(p2);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.dispose();
});

test("a failed load forwards the original rejection and can be retried", async () => {
  const loader = new FakeLoader(mockGL());
  const reason = new Error("boom");
  const first = loader.load(7);
  loader.rejectAttempt(0, reason);
  await expect(first).rejects.toBe(reason);
  expect(loader.get(7)).toBeUndefined();

  // The rejected attempt must not stay cached: retry must hit loadNoCache.
  const second = loader.load(7);
  expect(second).not.toBe(first);
  expect(loader.loadNoCacheCalls).toBe(2);
  loader.resolveAttempt(1, 7);
  const result = await second;
  expect(loader.get(7)).toBe(result);
  loader.dispose();
});

test("a rejection from a cancelled attempt does not discard the retried load", async () => {
  const loader = new FakeLoader(mockGL());
  const stale = loader.load(7);
  loader.cancelLoad(7);
  const fresh = loader.load(7);
  expect(loader.loadNoCacheCalls).toBe(2);

  // The abandoned attempt now fails; that must not clobber the new one.
  loader.rejectAttempt(0, new Error("stale failure"));
  await expect(stale).rejects.toThrow(/stale failure/);
  expect(loader.load(7)).toBe(fresh);

  loader.resolveAttempt(1, 7);
  const result = await fresh;
  expect(loader.get(7)).toBe(result);
  loader.dispose();
});

test("cancelLoad invokes the underlying dispose and clears the promise", () => {
  const loader = new FakeLoader(mockGL());
  loader.load(42);
  expect(loader.disposeCalls).toBe(0);
  loader.cancelLoad(42);
  expect(loader.disposeCalls).toBe(1);
  // After cancel, a fresh load() must call loadNoCache again.
  loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(2);
  loader.dispose();
});

test("a late success after cancelLoad is dropped and the next load starts over", async () => {
  const loader = new FakeLoader(mockGL());
  const cancelled = loader.load(3);
  loader.cancelLoad(3);

  loader.resolveAttempt(0, 3);
  await flush();
  expect(loader.get(3)).toBeUndefined();
  expect(await settleState(cancelled)).toBe("timeout");

  const retried = loader.load(3);
  expect(retried).not.toBe(cancelled);
  expect(loader.loadNoCacheCalls).toBe(2);
  loader.resolveAttempt(1, 3);
  const result = await retried;
  expect(loader.get(3)).toBe(result);
  loader.dispose();
});

test("a late success from a cancelled attempt does not overwrite a newer load", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  loader.load(3);
  loader.cancelLoad(3);
  const fresh = loader.load(3);

  // The abandoned attempt resolves while the retry is still in flight.
  loader.resolveAttempt(0, 100);
  await flush();
  expect(loader.get(3)).toBeUndefined();

  loader.resolveAttempt(1, 3);
  const result = await fresh;
  expect((result.texture as unknown as { id: number }).id).toBe(3);
  expect(loader.get(3)).toBe(result);

  loader.dispose();
  // Only the texture that actually made it into the cache is deleted.
  expect(deleted).toEqual([result.texture]);
});

test("dispose while a load is in flight drops the late result", async () => {
  const loader = new FakeLoader(mockGL());
  const p = loader.load(9);
  loader.dispose();
  loader.resolveAttempt(0, 9);
  await flush();
  expect(loader.get(9)).toBeUndefined();
  expect(await settleState(p)).toBe("timeout");
});

test("a load started after dispose never makes get() return a result", async () => {
  const loader = new FakeLoader(mockGL());
  loader.dispose();
  const p = loader.load(9);
  loader.resolveAttempt(0, 9);
  await flush();
  expect(loader.get(9)).toBeUndefined();
  expect(await settleState(p)).toBe("timeout");
});

test("dispose deletes every cached texture exactly once", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  const pa = loader.load(1);
  loader.resolveAttempt(0, 1);
  const pb = loader.load(2);
  loader.resolveAttempt(1, 2);
  const a = await pa;
  const b = await pb;
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});
