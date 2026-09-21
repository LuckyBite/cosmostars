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

FRONTEND_DIR = Path(os.environ.get('COSMOSTARS_FRONTEND_DIR', ROOT / 'frontend' / 'dist'))
# Same-origin by default: the container serves the built interface itself, so
# nothing has to be allowed in. The variable exists for split-origin work, where
# the interface runs on the Vite dev server against this service.
ALLOWED_ORIGINS = [origin for origin in
                   os.environ.get('COSMOSTARS_ALLOWED_ORIGINS', '*').split(',') if origin]

# A full shift costs ~17 MB in memory on the daily scenario and ~26 MB on the
# overloaded one, so the default is set for the smallest target we deploy to: a
# 512 MB free instance. On a normal machine raise it.
MAX_RUNS = int(os.environ.get('COSMOSTARS_MAX_RUNS', '12'))
MAX_UPLOAD_BYTES = int(os.environ.get('COSMOSTARS_MAX_UPLOAD_BYTES', str(64 * 1024 * 1024)))
