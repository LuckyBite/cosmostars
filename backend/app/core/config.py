"""Paths and service-wide settings.

The reference library is used as shipped and imported from the repository root,
the same way its own command line expects to be run, so a saved result replays
with the documented command and no path from a developer machine.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / 'data'
EXAMPLES_DIR = ROOT / 'examples'
EXPORT_DIR = Path(os.environ.get('COSMOSTARS_EXPORT_DIR', ROOT / 'exports'))

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MAX_RUNS = int(os.environ.get('COSMOSTARS_MAX_RUNS', '64'))
MAX_UPLOAD_BYTES = int(os.environ.get('COSMOSTARS_MAX_UPLOAD_BYTES', str(64 * 1024 * 1024)))
