"""One shift under execution: session, planner and the operator's history.

A run owns exactly one executed history. Branching copies the whole run, so two
continuations from the same control state share their past and nothing else:
each keeps its own environment, its own planner state and its own event log.
"""
from __future__ import annotations

import copy
import functools
import itertools
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Concatenate, ParamSpec, TypeVar

from model.operations import Session

from ..planner import DEFAULT_PLANNER, StepView, build_planner, check_goal, feasibility
from ..planner import downlink as downlink_mod
from ..planner.smart import SmartPlanner
from . import audit as audit_mod
from . import config  # noqa: F401  (puts the repository root on sys.path)
from . import explain as explain_mod
from .errors import BadRequest, EventRejected

_counter = itertools.count(1)

UNKNOWN_CELL = ' '

P = ParamSpec('P')
T = TypeVar('T')


def _guarded(method: Callable[Concatenate[Run, P], T]) -> Callable[Concatenate[Run, P], T]:
    """Serialise every call on one run.

    The service answers each request in its own thread, and two requests for
    the same shift do arrive together: a second tab, a jury route running while
    the operator clicks, a message posted while an hour is being computed.
    Planning a step while another thread executes one corrupts both — the
    planner reads a job index the other thread is rewriting — so every
    operation on a run holds that run's own lock. Runs never wait for each other.
    """
    @functools.wraps(method)
    def wrapper(self: Run, *args: P.args, **kwargs: P.kwargs) -> T:
        with self._lock:
            return method(self, *args, **kwargs)
    return wrapper


def _intervals(flags: list[Any]) -> list[list[int]]:
    """Half-open runs of truth in a boolean series: [[start, end), ...]."""
    out: list[list[int]] = []
    start: int | None = None
    for k, flag in enumerate(flags):
        if flag and start is None:
            start = k
        elif not flag and start is not None:
            out.append([start, k])
            start = None
    if start is not None:
        out.append([start, len(flags)])
    return out


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds')


class Run:
    """Wraps a library session with the planner and the operator-facing views."""

    def __init__(self, scenario: dict[str, Any], scenario_key: str,
                 planner_name: str = DEFAULT_PLANNER, goal: str = 'priority',
                 title: str | None = None, parameters: dict[str, Any] | None = None) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.scenario_key = scenario_key
        self.scenario_id = scenario['meta']['id']
        self.title = title or f'{scenario_key} · {goal} · #{next(_counter)}'
        self.created_at = _now()
        self.parent_id: str | None = None
        self.forked_at_step: int | None = None
        self.goal_switches: list[dict[str, Any]] = []
        self._lock = threading.RLock()
        self.planner = build_planner(planner_name, goal, **(parameters or {}))
        self.session = Session(scenario, run_metadata=self._run_metadata())
        self.view = StepView(self.session.env)
        # The ceiling is a forward-looking bound, so the one taken now covers
        # the whole shift and stays the yardstick for its result. Messages can
        # only take contact away, never add it, so this snapshot remains an
        # upper bound for the rest of the shift even after an outage.
        self.initial_feasibility = feasibility.analyse(self.view)

    # --- identity ---------------------------------------------------------
    @property
    def step(self) -> int:
        return self.session.env.k

    @property
    def total_steps(self) -> int:
        return self.session.env.s['time']['steps']

    @property
    def finished(self) -> bool:
        return self.step >= self.total_steps

    @property
    def goal(self) -> str:
        return self.planner.goal

    @_guarded
    def summary(self) -> dict[str, Any]:
        """The library's figures for the executed part of the shift."""
        return self.session.summary()

    def _run_metadata(self) -> dict[str, Any]:
        data = self.planner.metadata()
        data['run_id'] = self.id
        data['scenario_key'] = self.scenario_key
        data['created_at'] = self.created_at
        if self.goal_switches:
            data['goal_switches'] = list(self.goal_switches)
        if self.parent_id:
            data['branched_from'] = {'run_id': self.parent_id, 'step': self.forked_at_step}
        return data

    # --- execution --------------------------------------------------------
    @_guarded
    def advance(self, steps: int = 1) -> int:
        """Run the planner for up to ``steps`` boundaries; returns steps executed."""
        if steps < 0:
            raise BadRequest('steps must not be negative')
        executed = 0
        while executed < steps and not self.finished:
            actions = self.planner.plan(self.view)
            self.session.advance(actions)
            executed += 1
        return executed

    @_guarded
    def advance_to(self, target_step: int) -> int:
        """Stop before the given step, as the operator asks for on the timeline."""
        if not 0 <= target_step <= self.total_steps:
            raise BadRequest(f'Step must be within 0..{self.total_steps}')
        if target_step < self.step:
            raise BadRequest('Executed history is never recomputed; branch instead')
        return self.advance(target_step - self.step)

    @_guarded
    def apply_event(self, event: dict[str, Any]) -> dict[str, Any]:
        """Accept one message at this boundary, or refuse it without side effects."""
        try:
            self.session.apply_event(event)
        except (ValueError, KeyError, TypeError) as exc:
            event_id = event.get('id') if isinstance(event, dict) else None
            raise EventRejected(str(exc), {'event_id': event_id}) from exc
        self.view.refresh()
        self.planner.on_event(event, self.view)
        return copy.deepcopy(event)

    @_guarded
    def set_goal(self, goal: str) -> None:
        """Switch the management goal; it only affects the steps still ahead."""
        goal = check_goal(goal)
        if goal == self.planner.goal:
            return
        self.planner.set_goal(goal)
        self.goal_switches.append({'step': self.step, 'goal': goal})

    @_guarded
    def fork(self, title: str | None = None) -> Run:
        """Independent continuation from this exact control state."""
        branch = copy.copy(self)
        branch.id = uuid.uuid4().hex[:12]
        branch.created_at = _now()
        branch.parent_id = self.id
        branch.forked_at_step = self.step
        branch.title = title or f'{self.title} → ветвь {branch.id[:4]}'
        branch._lock = threading.RLock()   # driven on its own, so it waits on nobody
        branch.session = self.session.fork()
        branch.planner = copy.deepcopy(self.planner)
        branch.goal_switches = list(self.goal_switches)
        branch.view = StepView(branch.session.env)
        return branch

    # --- operator views ---------------------------------------------------
    @_guarded
    def info(self) -> dict[str, Any]:
        return {
            'run_id': self.id,
            'title': self.title,
            'scenario_key': self.scenario_key,
            'scenario_id': self.scenario_id,
            'goal': self.goal,
            'planner': self.planner.name,
            'planner_version': self.planner.version,
            'parameters': dict(self.planner.parameters),
            'step': self.step,
            'total_steps': self.total_steps,
            'finished': self.finished,
            'created_at': self.created_at,
            'parent_id': self.parent_id,
            'forked_at_step': self.forked_at_step,
            'goal_switches': list(self.goal_switches),
            'events_received': len(self.session.events),
            'summary': self.session.summary(),
        }

    @_guarded
    def satellites(self) -> list[dict[str, Any]]:
        env = self.session.env
        valid_for = env.s['model']['calibration_valid_steps']
        last: dict[str, dict[str, Any]] = {}
        # Utilisation as the data description defines it: the share of executed
        # steps spent on jobs, with waiting and calibration counted apart, and
        # no share at all before the first step rather than an invented zero.
        spent: dict[str, dict[str, int]] = {sid: {'job': 0, 'calibrate': 0, 'idle': 0}
                                            for sid in env.sats}
        for row in env.trace:
            spent[row['satellite_id']][row['executed']] += 1
        for row in reversed(env.trace):
            last.setdefault(row['satellite_id'], row)
            if len(last) == len(env.sats):
                break
        out = []
        for sid in sorted(env.sats):
            spec = env.sats[sid]
            state = env.state[sid]
            row = last.get(sid)
            out.append({
                'satellite_id': sid,
                'capacity_wh': spec['capacity_wh'],
                'energy_wh': round(state['energy_wh'], 6),
                'soc_pct': round(100 * state['energy_wh'] / spec['capacity_wh'], 6),
                'temp_c': round(state['temp_c'], 6),
                'calibration_age_steps': state['calibration_age_steps'],
                'calibration_valid_steps': valid_for,
                'calibration_expired': state['calibration_age_steps'] >= valid_for,
                'available': env.available(sid),
                'steps_executed': self.step,
                'job_steps': spent[sid]['job'],
                'calibrate_steps': spent[sid]['calibrate'],
                'idle_steps': spent[sid]['idle'],
                'utilization_pct': (round(100 * spent[sid]['job'] / self.step, 2)
                                    if self.step else None),
                'downlink_now': self.view.contact(sid, 'downlink') if not self.finished else None,
                'relay_now': self.view.contact(sid, 'relay') if not self.finished else None,
                'last_action': row['executed'] if row else None,
                'last_reason': row['reason'] if row else None,
            })
        return out

    @_guarded
    def jobs(self, status: str = 'all', limit: int = 200, offset: int = 0) -> dict[str, Any]:
        env = self.session.env
        step = self.step
        rows = []
        for job in env.jobs.values():
            if job['completed_step'] is not None:
                state = 'completed'
            elif job['deadline_step'] <= step:
                state = 'missed'
            elif job['release_step'] > step:
                state = 'pending'
            else:
                state = 'open'
            if status != 'all' and state != status:
                continue
            rows.append({
                'job_id': job['id'],
                'kind': job['kind'],
                'priority': job['priority'],
                'value_usd': job['value_usd'],
                'release_step': job['release_step'],
                'deadline_step': job['deadline_step'],
                'work_steps': job['work_steps'],
                'remaining_steps': job['remaining_steps'],
                'progress_steps': job['work_steps'] - job['remaining_steps'],
                'eligible_satellites': job['eligible_satellites'],
                'completed_step': job['completed_step'],
                'state': state,
            })
        rows.sort(key=lambda r: (r['deadline_step'], r['job_id']))
        return {'total': len(rows), 'offset': offset, 'limit': limit,
                'items': rows[offset:offset + limit]}

    @_guarded
    def trace(self, from_step: int | None = None, to_step: int | None = None,
              satellite_id: str | None = None, limit: int = 2000) -> dict[str, Any]:
        rows = self.session.env.trace
        lo = 0 if from_step is None else from_step
        hi = self.step if to_step is None else to_step
        picked = [row for row in rows
                  if lo <= row['step'] < hi
                  and (satellite_id is None or row['satellite_id'] == satellite_id)]
        return {'total': len(picked), 'limit': limit, 'items': picked[:limit]}

    @_guarded
    def series(self, satellite_id: str) -> dict[str, Any]:
        env = self.session.env
        if satellite_id not in env.sats:
            raise BadRequest(f'Unknown satellite {satellite_id!r}')
        capacity = env.sats[satellite_id]['capacity_wh']
        points = [{
            'step': row['step'],
            'soc_pct': round(100 * row['energy_after_wh'] / capacity, 4),
            'temp_c': row['temp_after_c'],
            'executed': row['executed'],
            'reason': row['reason'],
            'solar_w': row['solar_w'],
            'load_w': row['load_w'],
        } for row in env.trace if row['satellite_id'] == satellite_id]
        return {
            'satellite_id': satellite_id,
            'capacity_wh': capacity,
            'reserve_soc_pct': env.s['model']['reserve_soc_pct'],
            'critical_soc_pct': env.s['model']['critical_soc_pct'],
            'points': points,
        }

    @_guarded
    def events(self) -> list[dict[str, Any]]:
        """Messages accepted so far, in receipt order.

        The timeline marks each one where it arrived, which is the only honest
        way to show that nothing ahead of the cursor was known any earlier.
        """
        return copy.deepcopy(self.session.events)

    @_guarded
    def contacts(self) -> dict[str, Any]:
        """Contact windows and announced outages, as intervals.

        The interface draws a 48 x 288 canvas over these; sending the raw
        boolean arrays would be thirteen thousand values per kind, while the
        windows themselves are a few hundred intervals.
        """
        env = self.session.env
        items = []
        for sid in sorted(env.sats):
            row: dict[str, Any] = {'satellite_id': sid}
            for kind in ('downlink', 'relay'):
                row[kind] = _intervals(env.s['environment'][sid][kind + '_available'])
            items.append(row)
        return {
            'total_steps': self.total_steps,
            'items': items,
            'outages': [{'satellite_id': f['satellite_id'],
                         'start_step': f['start_step'],
                         'end_step': f['end_step']} for f in env.s['failures']],
        }

    @_guarded
    def grid(self) -> dict[str, Any]:
        """The executed shift as one character per satellite-step.

        The canvas needs all 48 x 288 cells at once, and the execution log is
        four megabytes of objects to say the same thing. One character per cell
        is fourteen kilobytes, so the interface can hold the whole shift and
        move the cursor without asking the service again.
        """
        env = self.session.env
        total = self.total_steps
        sats = sorted(env.sats)
        kinds = {job_id: job['kind'] for job_id, job in env.jobs.items()}
        actions = {sid: [UNKNOWN_CELL] * total for sid in sats}
        soc = {sid: [None] * total for sid in sats}
        for row in env.trace:
            sid, k = row['satellite_id'], row['step']
            if k >= total:
                continue
            requested = (row.get('requested') or {}).get('job_id')
            if row['executed'] == 'job':
                cell = 'd' if kinds.get(requested) == 'downlink' else 'r'
            elif row['executed'] == 'calibrate':
                cell = 'c'
            elif requested is not None or row['reason'] not in ('idle', 'no_admissible_work'):
                cell = 'x'   # a command was issued for this satellite and refused
            else:
                cell = '.'
            actions[sid][k] = cell
            soc[sid][k] = round(100 * row['energy_after_wh'] / env.sats[sid]['capacity_wh'])
        return {
            'step': self.step,
            'total_steps': total,
            'satellites': sats,
            'actions': {sid: ''.join(cells) for sid, cells in actions.items()},
            'soc': soc,
            'progress': self._progress(total),
            'legend': {'d': 'downlink', 'r': 'relay', 'c': 'calibrate', 'x': 'refused',
                       '.': 'idle', UNKNOWN_CELL: 'not executed yet'},
        }

    def _progress(self, total: int) -> dict[str, list[float]]:
        """Per-step increments of the official figures, for the cursor to sum.

        Each series is attributed to the step the library attributes it to:
        completion and revenue land on the step a job finished, obligations and
        misses on the step a deadline fell. Summing any of them up to the
        cursor gives exactly what ``summary()`` reports there, so moving the
        cursor never shows a number the service would not also report.
        """
        names = ('completed', 'due', 'missed', 'critical_due', 'critical_done')
        counts: dict[str, list[float]] = {name: [0] * (total + 1) for name in names}
        counts['revenue_usd'] = [0.0] * (total + 1)
        for job in self.session.env.jobs.values():
            done, deadline = job['completed_step'], job['deadline_step']
            if done is not None and done <= total:
                counts['completed'][done] += 1
                counts['revenue_usd'][done] += job['value_usd']
            if deadline <= total:
                counts['due'][deadline] += 1
                if done is None:
                    counts['missed'][deadline] += 1
                if job['priority'] == 3:
                    counts['critical_due'][deadline] += 1
                    if done is not None:
                        counts['critical_done'][deadline] += 1
        counts['revenue_usd'] = [round(value, 6) for value in counts['revenue_usd']]
        return counts

    @_guarded
    def audit(self) -> dict[str, Any]:
        """Пересчёт исполненной истории реализацией, не зависящей от библиотеки."""
        return audit_mod.audit(self)

    @_guarded
    def explain_job(self, job_id: str) -> dict[str, Any]:
        """Layered account of one job's fate: data, contest, satellite."""
        return explain_mod.explain(self, job_id)

    @_guarded
    def slot_prices(self) -> dict[str, Any] | None:
        """What each contested contact slot cost, when a schedule exists."""
        if not isinstance(self.planner, SmartPlanner):
            return None
        self.view.refresh()
        schedule = self.planner.schedule
        if schedule is None:
            return None
        return downlink_mod.slot_prices(self.view, schedule)

    @_guarded
    def feasibility(self) -> dict[str, Any]:
        """What is provable now, alongside what was provable at the start.

        Both are needed and they answer different questions: the live report
        says what is still out of reach, the opening snapshot says what the
        shift could ever have achieved — which is the only honest denominator
        for a finished shift.
        """
        self.view.refresh()
        report = feasibility.analyse(self.view)
        report['at_open'] = self.initial_feasibility
        return report

    @_guarded
    def downlink_plan(self) -> dict[str, Any] | None:
        """The committed transmission schedule, when the planner keeps one."""
        if not isinstance(self.planner, SmartPlanner):
            return None
        self.view.refresh()
        schedule = self.planner.schedule
        return schedule.as_dict() if schedule is not None else None

    @_guarded
    def result(self) -> dict[str, Any]:
        """Machine-readable export, replayable by the reference library."""
        self.session.run_metadata = self._run_metadata()
        return self.session.result()
