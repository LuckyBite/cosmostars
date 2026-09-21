"""Replay a saved export through the reference library and report convergence.

Both technical criteria about reproducibility come down to one question: does
the saved log recompute to the same shift? The check belongs in the service so
that an expert gets the answer in the browser instead of after cloning a repo,
and it is run by the shipped library — ``replay_episode`` — not by our planner,
so a passing report says nothing about our code being trusted.

The same check by hand, on the same file:

    python model/operations.py --result result.json --output replay.json
"""
from __future__ import annotations

from typing import Any

from . import config  # noqa: F401  (puts the repository root on sys.path)
from .errors import BadRequest

from model.operations import RESULT_SCHEMA, digest, replay_episode  # noqa: E402

TOLERANCE = 1e-9
MAX_MISMATCHES = 40
REPLAY_COMMAND = 'python model/operations.py --result result.json --output replay.json'


def _close(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) <= TOLERANCE * max(1.0, abs(float(right)))
    return False


def _diff(saved: Any, replayed: Any, path: str = '') -> list[dict[str, Any]]:
    """Field-by-field divergence, with a floating-point tolerance stated openly."""
    if isinstance(saved, dict) and isinstance(replayed, dict):
        out: list[dict[str, Any]] = []
        for key in sorted(set(saved) | set(replayed)):
            out += _diff(saved.get(key), replayed.get(key), f'{path}.{key}' if path else str(key))
        return out
    if saved == replayed or _close(saved, replayed):
        return []
    return [{'field': path, 'in_file': saved, 'replayed': replayed}]


def _required(payload: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> Any:
    value = payload.get(key)
    if not isinstance(value, kind):
        raise BadRequest(f'Export is missing a usable {key!r}')
    return value


def verify(payload: dict[str, Any]) -> dict[str, Any]:
    """Recompute a ``cosmo-B-ops-result-1.0`` export and compare it to itself."""
    if not isinstance(payload, dict):
        raise BadRequest('Export must be a JSON object')
    schema = payload.get('schema_version')
    if schema != RESULT_SCHEMA:
        raise BadRequest(f'Unsupported export schema {schema!r}, expected {RESULT_SCHEMA!r}')

    scenario = _required(payload, 'initial_scenario', dict)
    events = _required(payload, 'events', list)
    commands = _required(payload, 'commands', list)
    steps = payload.get('steps_executed')
    if not isinstance(steps, int) or isinstance(steps, bool):
        raise BadRequest('Export is missing a usable steps_executed')

    recomputed_hash = digest(scenario)
    stated_hash = payload.get('initial_scenario_hash')

    try:
        session = replay_episode(scenario, events, commands, steps)
    except (ValueError, KeyError, TypeError) as exc:
        raise BadRequest(f'Replay refused this export: {exc}') from exc

    replayed_summary = session.summary()
    saved_summary = payload.get('summary') if isinstance(payload.get('summary'), dict) else {}
    mismatches = _diff(saved_summary, replayed_summary)

    saved_trace = payload.get('trace') if isinstance(payload.get('trace'), list) else None
    trace_digest_saved = digest(saved_trace) if saved_trace is not None else None
    trace_digest_replayed = digest(session.env.trace)
    first_divergence = None
    if saved_trace is not None and trace_digest_saved != trace_digest_replayed:
        for i, (left, right) in enumerate(zip(saved_trace, session.env.trace)):
            if _diff(left, right):
                first_divergence = {'row': i, 'fields': _diff(left, right)[:MAX_MISMATCHES]}
                break

    scenario_match = stated_hash == recomputed_hash
    summary_match = not mismatches
    trace_match = saved_trace is None or trace_digest_saved == trace_digest_replayed
    return {
        'verdict': 'reproduced' if (scenario_match and summary_match and trace_match)
                   else 'diverged',
        'schema_version': schema,
        'run_metadata': payload.get('run_metadata'),
        'scenario': {
            'id': scenario.get('meta', {}).get('id'),
            'hash_in_file': stated_hash,
            'hash_recomputed': recomputed_hash,
            'match': scenario_match,
        },
        'replay': {
            'steps_executed_in_file': steps,
            'steps_executed_replayed': session.env.k,
            'events_replayed': len(events),
            'commands_replayed': len(commands),
            'match': session.env.k == steps,
        },
        'summary': {
            'match': summary_match,
            'fields_compared': len(saved_summary),
            'mismatches': mismatches[:MAX_MISMATCHES],
            'replayed': replayed_summary,
        },
        'trace': {
            'match': trace_match,
            'rows_in_file': len(saved_trace) if saved_trace is not None else None,
            'rows_replayed': len(session.env.trace),
            'digest_in_file': trace_digest_saved,
            'digest_replayed': trace_digest_replayed,
            'first_divergence': first_divergence,
        },
        'tolerance': TOLERANCE,
        'checked_by': 'model.operations.replay_episode',
        'same_check_by_hand': REPLAY_COMMAND,
    }
