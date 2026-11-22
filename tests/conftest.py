import os
import sys

# Make the test fakes package importable regardless of pytest's rootdir handling
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
