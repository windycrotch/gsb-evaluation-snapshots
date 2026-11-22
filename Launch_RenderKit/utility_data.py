import threading

_lock = threading.Lock()
_state = {
	"start_time": 0.0,
	"start_frame": -1,
	"serial_used": False,
	"sequence_active": False,
	"estimated_time": -1.0,
	# Set True by the render_cancel handler wrapper for the current render invocation,
	# reset to False whenever a new render starts (render_set_start)
	"render_cancelled": False,
}

# Batch-level cancellation latch. The render_cancel handler sets this True while a
# batch session is active; the batch loop reads (and clears) it after each target so
# that a user pressing Escape stops the whole batch rather than just one render.
_batch_cancel = False

# Cached addon preferences reference, captured once at render_init and used during the
# render loop. Reading bpy.context inside render_pre/render_post handlers every frame is a
# known trigger for "Python context internal state bug" on long sequences, so handlers read
# from this cache instead. The reference is cleared on render_set_end() to keep its lifetime
# bound to a single render and avoid stale StructRNA references after addon reload or reload.
_prefs = None

##################################################
# Set data groups

def render_set_start(start_time: float):
	with _lock:
		_state["start_time"] = float(start_time)
		_state["start_frame"] = -1
		_state["serial_used"] = False
		_state["sequence_active"] = False
		_state["estimated_time"] = -1.0
		_state["render_cancelled"] = False

def render_set_end():
	global _prefs
	with _lock:
		_state["start_time"] = 0.0
		_state["start_frame"] = -1
		_state["sequence_active"] = False
		_state["estimated_time"] = -1.0
		_prefs = None

# Set individual data elements

def render_set_start_time(time: float):
	with _lock:
		_state["start_time"] = float(time)

def render_set_start_frame(frame: int):
	with _lock:
		if _state["start_frame"] < 0:
			_state["start_frame"] = frame

def render_set_serial(used: bool):
	with _lock:
		_state["serial_used"] = used

def render_set_sequence(frame: int):
	with _lock:
		if not _state["sequence_active"] and _state["start_frame"] > -1 and _state["start_frame"] < frame:
			_state["sequence_active"] = True

def render_set_estimate(time: float):
	with _lock:
		_state["estimated_time"] = float(time)

# Cache / read the addon preferences reference for use inside render handlers

def cache_prefs(prefs):
	global _prefs
	with _lock:
		_prefs = prefs

def get_prefs():
	with _lock:
		return _prefs

##################################################
# Get data groups

def render_get_data():
	# UI uses this to read a consistent view
	with _lock:
		return dict(_state)

# Get individual data elements

def render_get_start_time():
	with _lock:
		return _state["start_time"]
	
def render_get_start_frame():
	with _lock:
		return _state["start_frame"]

def render_get_serial():
	with _lock:
		return _state["serial_used"]

def render_get_sequence():
	with _lock:
		return _state["sequence_active"]
	
def render_get_estimate():
	with _lock:
		return _state["estimated_time"]

##################################################
# Render cancellation tracking

def render_set_cancelled(cancelled: bool):
	with _lock:
		_state["render_cancelled"] = bool(cancelled)

def render_get_cancelled():
	with _lock:
		return _state["render_cancelled"]

##################################################
# Batch cancellation latch
# Independent of the per-render flag so it survives the render_set_start() reset
# triggered by the next target's render_init handler.

def batch_set_cancel_requested(requested: bool):
	global _batch_cancel
	with _lock:
		_batch_cancel = bool(requested)

def batch_get_cancel_requested():
	with _lock:
		return _batch_cancel