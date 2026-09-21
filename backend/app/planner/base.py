"""Planner contract and the shared step assembler.

A planner receives a :class:`StepView` at a step boundary and returns one action
per satellite. The library rejects conflicting commands, but the statement is
explicit that the planner must resolve them itself, so every planner builds its
step through :class:`StepPlan`, which enforces the shared limits up front and
records why each rejected candidate was dropped.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .view import Action, Job, StepView

GOALS = ('priority', 'revenue')
CRITICAL_PRIORITY = 3


def check_goal(goal: str) -> str:
    if goal not in GOALS:
        raise ValueError(f'Unknown goal {goal!r}, expected one of {GOALS}')
    return goal


def job_score(job: Job, goal: str) -> float:
    """Ranking weight of a job under the selected management goal.

    Priority and price are independent in this case, so the two goals really do
    order the same queue differently: value only breaks ties under 'priority'.
    """
    value = float(job['value_usd'])
    if goal == 'priority':
        return (1_000_000.0 if job['priority'] == CRITICAL_PRIORITY else 0.0) + value
    return value


class StepPlan:
    """Commands for one step, assembled under the shared resource limits."""

    def __init__(self, view: StepView) -> None:
        self.view = view
        self.actions: dict[str, Action] = {}
        self.notes: list[dict[str, Any]] = []
        self._claimed_jobs: set[str] = set()
        self._downlinks = 0
        self._downlink_limit = view.model['downlink_parallel_limit']

    @property
    def downlink_slots_left(self) -> int:
        return self._downlink_limit - self._downlinks

    def job_taken(self, job_id: str) -> bool:
        return job_id in self._claimed_jobs

    def _note(self, sid: str, job_id: str | None, reason: str) -> None:
        self.notes.append({'satellite_id': sid, 'job_id': job_id, 'reason': reason})

    def try_job(self, sid: str, job: Job) -> bool:
        """Assign a job to a satellite if every constraint allows it."""
        if sid in self.actions:
            return False
        job_id = job['id']
        if job_id in self._claimed_jobs:
            self._note(sid, job_id, 'taken_by_another_satellite')
            return False
        is_downlink = job['kind'] == 'downlink'
        if is_downlink and self._downlinks >= self._downlink_limit:
            self._note(sid, job_id, 'ground_capacity')
            return False
        ok, reason, _ = self.view.can_execute(sid, {'action': 'job', 'job_id': job_id})
        if not ok:
            self._note(sid, job_id, reason)
            return False
        self.actions[sid] = {'action': 'job', 'job_id': job_id}
        self._claimed_jobs.add(job_id)
        self._downlinks += int(is_downlink)
        return True

    def try_calibrate(self, sid: str) -> bool:
        if sid in self.actions:
            return False
        ok, reason, _ = self.view.can_execute(sid, {'action': 'calibrate'})
        if not ok:
            self._note(sid, None, reason)
            return False
        self.actions[sid] = {'action': 'calibrate'}
        return True

    def idle(self, sid: str, reason: str = 'no_admissible_work') -> None:
        if sid not in self.actions:
            self.actions[sid] = {'action': 'idle'}
            self._note(sid, None, reason)

    def finish(self) -> dict[str, Action]:
        for sid in self.view.satellite_ids:
            self.idle(sid)
        return self.actions


class Planner(ABC):
    """Chooses one action per satellite at every step boundary."""

    name = 'planner'
    version = '0.1'

    def __init__(self, goal: str = 'priority', **parameters: Any) -> None:
        self.goal = check_goal(goal)
        self.parameters = dict(parameters)

    def set_goal(self, goal: str) -> None:
        """Goal may change at a step boundary; it only affects later steps."""
        self.goal = check_goal(goal)

    def on_event(self, event: dict[str, Any], view: StepView) -> None:
        """Hook for planners that keep a precomputed schedule."""

    @abstractmethod
    def plan(self, view: StepView) -> dict[str, Action]:
        ...

    def metadata(self) -> dict[str, Any]:
        return {'algorithm': self.name, 'version': self.version,
                'goal': self.goal, 'parameters': dict(self.parameters)}
