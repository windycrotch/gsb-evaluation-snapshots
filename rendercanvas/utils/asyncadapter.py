"""
A micro async framework that only support ``sleep()`` and ``Event``. Behaves well with ``sniffio``.
Intended for internal use, but is fully standalone.
"""

import logging
import threading
import weakref

# Support sniffio, play nice.
# Note that in rendercanvas we recommend using sys.get_asyncgen_hooks to detect the current loop object,
# because that is faster and also works for events and call-later's.
try:
    from sniffio import thread_local as sniffio_thread_local
except ImportError:
    sniffio_thread_local = threading.local()


logger = logging.getLogger("asyncadapter")


class Sleeper:
    def __init__(self, delay):
        self.delay = delay

    def __await__(self):
        # This most be a generator, but it is unspecified what must be yielded; this
        # is framework-specific. So we use our own little protocol.
        yield {"wait_method": "sleep", "delay": self.delay}


async def sleep(delay):
    """Async sleep for delay seconds."""
    # This effectively runs via the call_later_func passed to the task.
    await Sleeper(delay)


class Event:
    """Event object similar to asyncio.Event and Trio.Event."""

    def __init__(self):
        self._is_set = False
        self._is_closed = False
        self._tasks = []

    def __repr__(self):
        state = "set" if self._is_set else "unset"
        if self._is_closed:
            state += "-closed"
        return f"<{self.__module__}.{self.__class__.__name__} object ({state}) at {hex(id(self))}>"

    async def wait(self):
        if self._is_set:
            pass
        else:
            await self  # triggers __await__

    def __await__(self):
        yield {"wait_method": "event", "event": self}

    def _add_task(self, task):
        # A task that is already done (e.g. cancelled when its loop stopped)
        # must never be re-attached. Reviving it on a later set() would
        # schedule a dead task's step-callback in a fresh loop iteration,
        # producing ghost callbacks and duplicated work.
        if task.coro is None or task.cancelled:
            return
        self._tasks.append(task)

    def set(self):
        self._is_set = True
        tasks = self._tasks
        self._tasks = []
        for task in tasks:
            # Skip tasks that were cancelled or closed while waiting.
            if task.coro is None or task.cancelled:
                continue
            task.call_step_later(0)

    def close(self):
        """Wake up every task currently waiting, without marking the event set.

        Used to release waiters when the thing they are waiting for can no
        longer happen (e.g. a canvas is closing). Unlike ``set()``, a later
        ``wait()`` on a closed event still suspends, so this cannot be confused
        with a successful completion.
        """
        self._is_closed = True
        tasks = self._tasks
        self._tasks = []
        for task in tasks:
            if task.coro is None or task.cancelled:
                continue
            task.call_step_later(0)


class CancelledError(BaseException):
    """Exception raised when a task is cancelled."""

    pass


class Task:
    """Representation of task, executing a co-routine."""

    def __init__(self, call_later_func, coro, name):
        self._call_later = call_later_func
        self._done_callbacks = []
        self.coro = coro
        self.name = name
        self.running = False
        self.cancelled = False

        # Trick to get a callback function that does not hold a ref to the task, and therefore not the loop (via the loop-task coro).
        task_ref = weakref.ref(self)
        self._step_cb = lambda: (task := task_ref()) and task.step()

        self.call_step_later(0)

    def add_done_callback(self, callback):
        self._done_callbacks.append(callback)

    def _close(self):
        self.coro = None
        for callback in self._done_callbacks:
            try:
                callback(self)
            except Exception:
                pass
        self._done_callbacks.clear()

    def call_step_later(self, delay):
        # Once the task is closed it must not schedule any further callbacks.
        # This prevents a stopped task from leaving ghost callbacks that could
        # fire after the loop is stopped and restarted.
        if self.coro is None:
            return
        self._call_later(delay, self._step_cb)

    def cancel(self):
        self.cancelled = True
        self.call_step_later(0)

    def step(self):
        if self.coro is None:
            return

        result = None
        stop = False

        old_name = getattr(sniffio_thread_local, "name", None)
        sniffio_thread_local.name = __name__

        self.running = True
        try:
            if self.cancelled:
                stop = True
                self.coro.throw(CancelledError())  # falls through if not caught
                self.coro.close()  # raises GeneratorExit
            else:
                result = self.coro.send(None)
        except CancelledError:
            stop = True
        except StopIteration:
            stop = True
        except Exception as err:
            # This catches some special cases where Python raises an error, such as 'coroutine already executing'
            logger.error(f"Error in task: {err}")
            stop = True
        finally:
            self.running = False
            sniffio_thread_local.name = old_name

        # Clean up to help gc
        if stop:
            return self._close()

        error = None

        if not (isinstance(result, dict) and result.get("wait_method", None)):
            error = f"Incompatible awaitable result {result!r} from coro {self.coro!r}. Maybe you used asyncio or trio (this does not run on either)?"
        else:
            wait_method = result["wait_method"]
            if wait_method == "sleep":
                self.call_step_later(result["delay"])
            elif wait_method == "event":
                result["event"]._add_task(self)
            else:
                error = f"Unknown wait_method {wait_method!r}."

        if error:
            logger.error(error)
            self.cancel()
            self.call_step_later(0)
