"""The Caller's lock state, delay validation and voice-sample length check, with a fake VoxLock in place of the
model: pass -> locked, degraded only after the lock and back to locked once the model catches up, a track change
that keeps the lock, a new caller that starts over.

    python tests/test_caller_state.py      (or pytest tests/test_caller_state.py)
"""
import threading
import time

import numpy as np

from voxlock import realtime
from voxlock.realtime import Caller, SR

rng = np.random.default_rng(0)


def noise(sec, level=0.1):
    return (rng.standard_normal(int(sec * SR)) * level).astype(np.float32)


class FakeStream:
    """Stands in for Stream/LiveStream: echoes its input 24 ms (384 samples) behind, and flips `locked` once it has
    heard `lock_after` samples (0: locked from the first push, as a stream built from a voice sample is)."""

    def __init__(self, lock_after=0, gate=None):
        self.lock_after = lock_after
        self.locked = lock_after <= 0
        self.gate = gate                           # while cleared, push() blocks: a model that cannot keep up
        self.n_in = 0
        self.tail = np.zeros(0, np.float32)

    def push(self, x):
        if self.gate is not None:
            self.gate.wait()
        x = np.asarray(x, np.float32)
        self.n_in += len(x)
        if self.n_in >= self.lock_after:
            self.locked = True
        self.tail = np.concatenate([self.tail, x])
        y = self.tail[: max(0, len(self.tail) - 384)]
        self.tail = self.tail[len(y):]
        return y


class FakeVoxLock:
    def __init__(self, lock_after=0, gate=None):
        self.lock_after, self.gate = lock_after, gate

    def stream(self, sample):
        return FakeStream(0, self.gate)

    def live(self, sec=3.0):
        return FakeStream(int(sec * SR), self.gate)


class use_fake:
    """Swap the model the Caller's worker loads for a fake one."""

    def __init__(self, lock_after=0, gate=None):
        self.fake = FakeVoxLock(lock_after, gate)

    def __enter__(self):
        self.real = realtime.preload
        realtime.preload = lambda **kw: self.fake
        return self.fake

    def __exit__(self, *exc):
        realtime.preload = self.real


def feed(c, x, frame=160):
    for i in range(0, len(x), frame):
        c.process(x[i: i + frame])


def wait_for(cond, what, timeout=10.0):
    t0 = time.perf_counter()
    while not cond():
        if time.perf_counter() - t0 > timeout:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.005)


def test_pass_until_the_lock_then_locked_with_locked_at():
    with use_fake(lock_after=3 * SR):
        c = Caller(chunk_ms=50)
        try:
            c.start_segment(SR, 160)
            assert c.state == "pass" and c.locked_at is None
            feed(c, noise(2.0))
            wait_for(lambda: c.taken >= 2 * SR - 800, "the worker to take 2 s")
            assert c.state == "pass" and c.locked_at is None      # 2 s heard: not enough for a lock
            feed(c, noise(2.0))
            wait_for(lambda: c.locked, "the lock")
            wait_for(lambda: c.taken >= 4 * SR - 800, "the worker to catch up")
            c.process(noise(0.01))                                # the state refreshes on each process() call
            assert c.state == "locked"
            assert 3 * SR <= c.locked_at <= c.taken               # the position the lock was taken at
            assert c.locked_at == c.locked_at                     # stable once set
        finally:
            c.close()


def test_voice_sample_locks_from_the_first_audio():
    with use_fake():
        c = Caller(voice_sample=noise(3.0), chunk_ms=50)
        try:
            c.start_segment(SR, 160)
            feed(c, noise(1.0))
            wait_for(lambda: c.locked, "the lock")
            wait_for(lambda: c.taken >= SR - 800, "the worker to catch up")
            c.process(noise(0.01))
            assert c.state == "locked"
            assert 0 < c.locked_at <= c.taken
        finally:
            c.close()


def test_short_voice_sample_rejected_at_construction():
    with use_fake():
        for sec in (0.0, 0.5, 2.999):
            try:
                Caller(voice_sample=noise(sec))
            except ValueError:
                continue
            raise AssertionError(f"a {sec} s voice sample was accepted")
        c = Caller(voice_sample=noise(3.0))                       # exactly 3 s is enough
        c.close()


def test_delay_ms_must_be_non_negative_and_finite():
    with use_fake():
        for bad in (-1.0, -0.001, float("nan"), float("inf"), float("-inf")):
            c = Caller(delay_ms=bad)
            try:
                c.start_segment(SR, 160)
            except ValueError:
                pass
            else:
                raise AssertionError(f"delay_ms={bad} was accepted")
            finally:
                c.close()
        c = Caller(delay_ms=50)
        try:
            c.start_segment(SR, 160)
            assert c.delay == 800
        finally:
            c.close()


def test_degraded_only_after_the_lock_and_back_to_locked():
    gate = threading.Event()
    with use_fake(gate=gate):
        c = Caller(chunk_ms=50)
        try:
            c.start_segment(SR, 160)
            gate.clear()                                          # the model stalls before the lock
            feed(c, noise(1.0))
            time.sleep(0.2)
            assert c.state == "pass"                              # never degraded before the lock
            gate.set()
            feed(c, noise(3.0))
            wait_for(lambda: c.locked, "the lock")
            wait_for(lambda: c.taken >= 4 * SR - 800, "the worker to catch up")
            c.process(noise(0.01))
            assert c.state == "locked"

            gate.clear()                                          # the model stalls on a locked call
            feed(c, noise(1.0))
            wait_for(lambda: c.state == "degraded", "the degraded state")
            assert c.missed > 0 and c.locked_at is not None

            gate.set()                                            # the model catches up again
            t0 = time.perf_counter()
            while c.state != "locked":
                c.process(noise(0.01))
                if time.perf_counter() - t0 > 10:
                    raise AssertionError("the state did not return to locked")
                time.sleep(0.01)
            assert c.locked_at is not None
        finally:
            gate.set()
            c.close()


def test_track_change_keeps_lock_and_locked_at():
    with use_fake():
        c = Caller(chunk_ms=50)
        try:
            c.start_segment(SR, 160)
            feed(c, noise(4.0))
            wait_for(lambda: c.locked, "the lock")
            wait_for(lambda: c.taken >= 4 * SR - 800, "the worker to take 4 s")
            at = c.locked_at
            assert at is not None

            c.start_segment(SR, 160)                              # same caller, new track (microphone toggle)
            assert c.state == "locked" and c.locked_at == at
            feed(c, noise(1.0))
            wait_for(lambda: c.taken >= SR - 800, "the worker to take the new segment")
            c.process(noise(0.01))
            assert c.state == "locked" and c.locked_at == at

            c.start_segment(48000, 480)                           # same caller, another rate
            assert c.state == "locked" and c.locked_at == at
        finally:
            c.close()


def test_new_caller_starts_over_at_pass():
    with use_fake():
        c = Caller(chunk_ms=50)
        try:
            c.start_segment(SR, 160)
            feed(c, noise(4.0))
            wait_for(lambda: c.locked, "the lock")
            wait_for(lambda: c.taken >= 4 * SR - 800, "the worker to catch up")
            c.process(noise(0.01))
            assert c.state == "locked" and c.locked_at is not None
        finally:
            c.close()
        c = Caller(chunk_ms=50)                                   # another participant: the wrappers drop the
        try:                                                      # old Caller and build a new one
            c.start_segment(SR, 160)
            assert c.state == "pass" and c.locked_at is None
            feed(c, noise(1.0))
            wait_for(lambda: c.taken >= SR - 800, "the worker to take 1 s")
            assert c.state == "pass" and c.locked_at is None
        finally:
            c.close()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"):
            f()
            print("ok", name)
