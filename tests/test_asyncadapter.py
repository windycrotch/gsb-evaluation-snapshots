"""
Test the functionality of the asyncadapter with the bare minimum boilderplate.
Using asyncio to drive the loop with call_later; the actual async
happens via asyncadapter.Task.
"""

import time

import asyncio
from rendercanvas.utils import asyncadapter


def test_sleep():
    times = []

    async def coro():
        times.append(time.perf_counter())
        await asyncadapter.sleep(0.05)
        times.append(time.perf_counter())
        await asyncadapter.sleep(0.1)
        times.append(time.perf_counter())

    loop = asyncio.new_event_loop()
    _task = asyncadapter.Task(loop.call_later, coro(), "test")

    loop.call_later(0.25, loop.stop)
    loop.run_forever()
    loop.close()

    sleep_time1 = times[1] - times[0]
    sleep_time2 = times[2] - times[1]
    assert 0.04 < sleep_time1 < 0.15
    assert 0.09 < sleep_time2 < 0.20


def test_event():
    event1 = asyncadapter.Event()
    event2 = asyncadapter.Event()

    times = []

    async def coro1():
        await asyncadapter.sleep(0.05)
        event1.set()
        await asyncadapter.sleep(0.1)
        event2.set()

    async def coro2():
        times.append(time.perf_counter())
        await event1.wait()
        times.append(time.perf_counter())
        await event2.wait()
        times.append(time.perf_counter())

    loop = asyncio.new_event_loop()

    _task1 = asyncadapter.Task(loop.call_later, coro1(), "test")
    _task2 = asyncadapter.Task(loop.call_later, coro2(), "test")

    loop.call_later(0.25, loop.stop)
    loop.run_forever()
    loop.close()

    sleep_time1 = times[1] - times[0]
    sleep_time2 = times[2] - times[1]
    assert 0.04 < sleep_time1 < 0.15
    assert 0.09 < sleep_time2 < 0.20


def test_event_close_releases_waiter_without_setting():
    # Event.close() must wake a waiting task but must not mark the event set.
    from rendercanvas.offscreen import StubLoop

    loop = StubLoop()
    event = asyncadapter.Event()
    woke = []

    async def waiter():
        await event.wait()
        woke.append(event._is_set)

    task = asyncadapter.Task(
        loop._unchecked_call_later_for_tasks, waiter(), "waiter"
    )
    loop.run()  # task parks on the event
    assert task.coro is not None  # still suspended

    event.close()
    loop.run()  # the closed event releases the task

    assert task.coro is None  # task completed
    assert woke == [False]  # it was a cancellation, not a successful set
    assert "closed" in repr(event)


def test_closed_task_is_not_resurrected_by_event_set():
    # A task cancelled while waiting must never be revived by a later set(),
    # which would schedule a ghost callback (the double-fps / zombie mechanism).
    from rendercanvas.offscreen import StubLoop

    loop = StubLoop()
    event = asyncadapter.Event()

    async def waiter():
        await event.wait()

    task = asyncadapter.Task(
        loop._unchecked_call_later_for_tasks, waiter(), "waiter"
    )
    loop.run()  # parks on the event
    assert task.coro is not None

    # Simulate the loop stopping: cancel the task and run one step to close it.
    task.cancel()
    task.step()
    assert task.coro is None
    pending_before = len(loop._callbacks)

    # A (stale) completion signal must not re-schedule the dead task.
    event.set()
    assert len(loop._callbacks) == pending_before


if __name__ == "__main__":
    test_sleep()
    test_event()
    test_event_close_releases_waiter_without_setting()
    test_closed_task_is_not_resurrected_by_event_set()
