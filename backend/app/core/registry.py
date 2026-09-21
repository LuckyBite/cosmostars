"""In-memory store of runs.

Runs are per-process and keyed by an opaque id, so two operators, or the same
operator in two tabs, never observe each other's shift. Nothing here is written
to disk: an export is the only durable artefact, which keeps the replay path and
the live path identical.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

from . import config, scenarios
from .errors import BadRequest, NotFound
from .run import Run


class RunRegistry:
    def __init__(self, max_runs: int = config.MAX_RUNS) -> None:
        self._runs: OrderedDict[str, Run] = OrderedDict()
        self._lock = threading.Lock()
        self._max_runs = max_runs

    def _insert(self, run: Run) -> Run:
        with self._lock:
            self._runs[run.id] = run
            while len(self._runs) > self._max_runs:
                # Least recently *used* goes first, not least recently created:
                # the shift an operator is looking at may well be the oldest one
                # in the process, and dropping it under them is the one eviction
                # that must never happen. Exports are unaffected either way.
                self._runs.popitem(last=False)
        return run

    def create(self, scenario_key: str, planner_name: str, goal: str,
               title: str | None = None, parameters: dict[str, Any] | None = None) -> Run:
        scenario = scenarios.get(scenario_key)
        run = Run(scenario, scenario_key, planner_name=planner_name, goal=goal,
                  title=title, parameters=parameters)
        return self._insert(run)

    def fork(self, run_id: str, title: str | None = None) -> Run:
        return self._insert(self.get(run_id).fork(title))

    def get(self, run_id: str) -> Run:
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                self._runs.move_to_end(run_id)
        if run is None:
            raise NotFound(f'Run {run_id!r} is not in this session')
        return run

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            runs = list(self._runs.values())
        return [run.info() for run in runs]

    def delete(self, run_id: str) -> None:
        with self._lock:
            if self._runs.pop(run_id, None) is None:
                raise NotFound(f'Run {run_id!r} is not in this session')

    def capacity(self) -> dict[str, int]:
        """How many shifts are held and how many fit, for the health check.

        A full shift costs about 17 MB on the daily scenario and 26 MB on the
        overloaded one, so the cap is what keeps a small free instance alive.
        """
        with self._lock:
            return {'runs_held': len(self._runs), 'runs_capacity': self._max_runs}

    def pair(self, left_id: str, right_id: str) -> tuple[Run, Run]:
        if left_id == right_id:
            raise BadRequest('Pick two different runs to compare')
        return self.get(left_id), self.get(right_id)


registry = RunRegistry()
