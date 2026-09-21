"""Scenario catalogue: the shipped set, the operator's uploads and derived variants.

Uploaded scenarios are validated by the reference library before they are
offered, so an unusable file is refused at load time with the library's own
message rather than halfway through a shift. A derived scenario is a catalogued
one with the changes the statement allows before a run — initial charge, solar
coefficient, job priority, a period of unavailability — saved under its own
identifier so that it is never mistaken for the original in a comparison.
"""
from __future__ import annotations

import collections
import json
import math
import threading
import uuid
from pathlib import Path
from typing import Any

from model.resource_env import validate

from . import config
from .errors import BadRequest

# Uploads and derived variants live in the process, like runs do, and are
# capped for the same reason: a scenario is a megabyte of JSON and several of
# Python objects, so an unbounded dictionary is a way to run a small machine out
# of memory one upload at a time. The least recently used one goes first.
MAX_STORED = 32
_stored: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
_lock = threading.Lock()


def _remember(key: str, scenario: dict[str, Any]) -> None:
    with _lock:
        _stored[key] = scenario
        _stored.move_to_end(key)
        while len(_stored) > MAX_STORED:
            _stored.popitem(last=False)


def _stored_copy(key: str) -> dict[str, Any] | None:
    with _lock:
        scenario = _stored.get(key)
        if scenario is not None:
            _stored.move_to_end(key)
    return None if scenario is None else json.loads(json.dumps(scenario))


def _bundled_path(key: str) -> Path | None:
    path = (config.DATA_DIR / f'{key}.json').resolve()
    return path if path.parent == config.DATA_DIR.resolve() and path.is_file() else None


def _check_key(key: str) -> None:
    if _bundled_path(key) is not None:
        raise BadRequest(f'Key {key!r} belongs to a bundled scenario; pick another one')


def _source(scenario: dict[str, Any]) -> str:
    return 'derived' if scenario['meta'].get('derived_from') else 'uploaded'


def brief(scenario: dict[str, Any]) -> dict[str, Any]:
    """Headline numbers an operator needs before starting a shift."""
    jobs = scenario['jobs']
    kinds = collections.Counter(job['kind'] for job in jobs)
    priorities = collections.Counter(job['priority'] for job in jobs)
    steps = scenario['time']['steps']
    step_s = scenario['time']['step_s']
    return {
        'id': scenario['meta']['id'],
        'title': scenario['meta']['title'],
        'steps': steps,
        'step_seconds': step_s,
        'duration_hours': round(steps * step_s / 3600, 2),
        'satellites': len(scenario['satellites']),
        'jobs_total': len(jobs),
        'jobs_downlink': kinds.get('downlink', 0),
        'jobs_relay': kinds.get('relay', 0),
        'jobs_by_priority': {str(p): priorities.get(p, 0) for p in (1, 2, 3)},
        'work_steps_total': sum(job['work_steps'] for job in jobs),
        'value_total_usd': round(sum(job['value_usd'] for job in jobs), 6),
        'known_outages': len(scenario['failures']),
        'downlink_parallel_limit': scenario['model']['downlink_parallel_limit'],
        'derived_from': scenario['meta'].get('derived_from'),
    }


def catalogue() -> list[dict[str, Any]]:
    """Shipped scenarios first, then anything uploaded or derived in this process."""
    items = []
    for path in sorted(config.DATA_DIR.glob('*.json')):
        try:
            scenario = json.loads(path.read_text(encoding='utf-8'))
            validate(scenario)
        except (ValueError, KeyError, TypeError, OSError):
            continue
        item = brief(scenario)
        item['source'] = 'bundled'
        item['key'] = path.stem
        items.append(item)
    with _lock:
        stored = list(_stored.items())
    for key, scenario in sorted(stored):
        item = brief(scenario)
        item['source'] = _source(scenario)
        item['key'] = key
        items.append(item)
    return items


def get(key: str) -> dict[str, Any]:
    """Load a scenario by catalogue key: bundled, uploaded or derived."""
    stored = _stored_copy(key)
    if stored is not None:
        return stored
    path = _bundled_path(key)
    if path is None:
        raise BadRequest(f'Unknown scenario {key!r}')
    scenario = json.loads(path.read_text(encoding='utf-8'))
    validate(scenario)
    return scenario


def register_upload(key: str, scenario: dict[str, Any]) -> dict[str, Any]:
    """Accept an operator-supplied scenario after the library validates it."""
    if not isinstance(scenario, dict):
        raise BadRequest('Scenario must be a JSON object')
    _check_key(key)
    try:
        validate(scenario)
    except (ValueError, KeyError, TypeError) as exc:
        raise BadRequest(f'Scenario rejected: {exc}') from exc
    _remember(key, scenario)
    item = brief(scenario)
    item['source'] = _source(scenario)
    item['key'] = key
    return item


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def derive(base_key: str, *,
           initial_soc_pct: dict[str, float] | None = None,
           solar_multiplier: float | None = None,
           job_priority: dict[str, int] | None = None,
           outages: list[dict[str, Any]] | None = None,
           key: str | None = None,
           title: str | None = None) -> dict[str, Any]:
    """A catalogued scenario with the operator's changes, saved as a new one.

    The statement lets the operator alter, before a run, the initial charge of a
    satellite, the solar power coefficient, the priority of an existing job and
    a satellite's unavailability, and requires the altered set to be kept as a
    scenario of its own. The result gets its own identifier, so a comparison
    between the base shift and the derived one is flagged as different
    conditions rather than passed off as one experiment. The provenance — base
    scenario and every change — is written into ``meta`` and therefore into
    every export made from a derived shift.
    """
    scenario = get(base_key)
    steps = scenario['time']['steps']
    satellites = {item['id']: item for item in scenario['satellites']}
    jobs = {job['id']: job for job in scenario['jobs']}
    changes: dict[str, Any] = {}

    for sid, soc in (initial_soc_pct or {}).items():
        if sid not in satellites:
            raise BadRequest(f'Unknown satellite {sid!r} in the initial charge change')
        if not _finite(soc) or not 0 <= soc <= 100:
            raise BadRequest(f'Initial charge of {sid} must be within 0..100 percent')
        satellites[sid]['initial_soc_pct'] = float(soc)
        changes.setdefault('initial_soc_pct', {})[sid] = float(soc)

    if solar_multiplier is not None:
        if not _finite(solar_multiplier) or solar_multiplier <= 0:
            raise BadRequest('Solar power coefficient must be a positive number')
        for environment in scenario['environment'].values():
            environment['solar_w'] = [value * solar_multiplier for value in environment['solar_w']]
        changes['solar_multiplier'] = solar_multiplier

    for job_id, priority in (job_priority or {}).items():
        if job_id not in jobs:
            raise BadRequest(f'Unknown job {job_id!r} in the priority change')
        if type(priority) is not int or not 1 <= priority <= 3:
            raise BadRequest(f'Priority of {job_id} must be 1, 2 or 3')
        jobs[job_id]['priority'] = priority
        changes.setdefault('job_priority', {})[job_id] = priority

    for outage in outages or []:
        target = outage.get('satellite_id')
        start, end = outage.get('start_step'), outage.get('end_step')
        if target not in satellites:
            raise BadRequest(f'Unknown satellite {target!r} in the unavailability change')
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= steps:
            raise BadRequest(f'Unavailability of {target} must satisfy 0 <= start < end <= {steps}')
        scenario['failures'].append({'satellite_id': target, 'start_step': start, 'end_step': end})
        changes.setdefault('outages', []).append(
            {'satellite_id': target, 'start_step': start, 'end_step': end})

    if not changes:
        raise BadRequest('No changes given: the derived scenario would equal the original')

    suffix = uuid.uuid4().hex[:4]
    new_key = key or f'{base_key}-mod-{suffix}'
    _check_key(new_key)
    meta = scenario['meta']
    base_id = meta['id']
    meta['id'] = f'{base_id}~{suffix}'
    meta['title'] = title or f'{meta["title"]} · изменённые условия'
    meta['derived_from'] = {'scenario': base_key, 'scenario_id': base_id, 'changes': changes}
    try:
        validate(scenario)
    except (ValueError, KeyError, TypeError) as exc:
        raise BadRequest(f'Derived scenario rejected by the library: {exc}') from exc
    _remember(new_key, scenario)
    item = brief(scenario)
    item['source'] = 'derived'
    item['key'] = new_key
    return item


def load_events(path_key: str) -> list[dict[str, Any]]:
    """Read one of the shipped event files (development aid, not the jury path)."""
    path = (config.EXAMPLES_DIR / f'{path_key}.json').resolve()
    if path.parent != config.EXAMPLES_DIR.resolve() or not path.is_file():
        raise BadRequest(f'Unknown event file {path_key!r}')
    payload = json.loads(path.read_text(encoding='utf-8'))
    events = payload.get('events') if isinstance(payload, dict) else payload
    if not isinstance(events, list):
        raise BadRequest('Event file must hold a list of events')
    return events
