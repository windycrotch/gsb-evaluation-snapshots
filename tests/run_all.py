# Run every local, render-free test in one process:
#   python -I tests/run_all.py
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = (
	'run_batch_tests.py',   # engine behaviour: success/failure/cancel/re-entry
	'run_import_smoke.py',  # full add-on package wiring against a bpy stub
)

failures = 0
for test_file in TESTS:
	print(f"\n=== {test_file} ===")
	try:
		result = runpy.run_path(os.path.join(HERE, test_file), run_name='__main__')
		exit_code = result.get('__exit_code', 0)
	except SystemExit as exc:
		exit_code = exc.code or 0
	except Exception:
		import traceback
		traceback.print_exc()
		exit_code = 1
	if exit_code:
		failures += 1
		print(f"--- {test_file} FAILED (exit {exit_code}) ---")

print()
if failures:
	print(f"{failures} test module(s) failed.")
	sys.exit(1)
print("All local test modules passed.")
