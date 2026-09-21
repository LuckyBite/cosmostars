"""Scenario catalogue: the shipped set plus whatever the operator uploads.

Uploaded scenarios are validated by the reference library before they are
offered, so an unusable file is refused at load time with the library's own
message rather than halfway through a shift.
"""
from __future__ import annotations

import collections
import json
from typing import Any

from model.resource_env import validate

from . import config
from .errors import BadRequest

_uploaded: dict[str, dict[str, Any]] = {}


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
    }


def catalogue() -> list[dict[str, Any]]:
    """Shipped scenarios first, then anything uploaded in this process."""
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
    for key, scenario in sorted(_uploaded.items()):
        item = brief(scenario)
        item['source'] = 'uploaded'
        item['key'] = key
        items.append(item)
    return items


def get(key: str) -> dict[str, Any]:
    """Load a scenario by catalogue key, bundled or uploaded."""
    if key in _uploaded:
        return json.loads(json.dumps(_uploaded[key]))
    path = (config.DATA_DIR / f'{key}.json').resolve()
    if path.parent != config.DATA_DIR.resolve() or not path.is_file():
        raise BadRequest(f'Unknown scenario {key!r}')
    scenario = json.loads(path.read_text(encoding='utf-8'))
    validate(scenario)
    return scenario


def register_upload(key: str, scenario: dict[str, Any]) -> dict[str, Any]:
    """Accept an operator-supplied scenario after the library validates it."""
    if not isinstance(scenario, dict):
        raise BadRequest('Scenario must be a JSON object')
    try:
        validate(scenario)
    except (ValueError, KeyError, TypeError) as exc:
        raise BadRequest(f'Scenario rejected: {exc}') from exc
    _uploaded[key] = scenario
    item = brief(scenario)
    item['source'] = 'uploaded'
    item['key'] = key
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
