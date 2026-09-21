"""Planner contract and the shared step assembler.

A planner receives a :class:`StepView` at a step boundary and returns one action
per satellite. The library rejects conflicting commands, but the statement is
explicit that the planner must resolve them itself, so every planner builds its
step through :class:`StepPlan`, which enforces the shared limits up front: one
executor per job, the global cap on simultaneous transmissions, and the
library's own admissibility check before a command is ever issued.
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
        self._claimed_jobs: set[str] = set()
        self._downlinks = 0
        self._downlink_limit = view.model['downlink_parallel_limit']

    def try_job(self, sid: str, job: Job) -> bool:
        """Assign a job to a satellite if every constraint allows it."""
        if sid in self.actions or job['id'] in self._claimed_jobs:
            return False
        is_downlink = job['kind'] == 'downlink'
        if is_downlink and self._downlinks >= self._downlink_limit:
            return False
        ok, _reason, _power = self.view.can_execute(sid, {'action': 'job', 'job_id': job['id']})
        if not ok:
            return False
        self.actions[sid] = {'action': 'job', 'job_id': job['id']}
        self._claimed_jobs.add(job['id'])
        self._downlinks += int(is_downlink)
        return True

    def try_calibrate(self, sid: str) -> bool:
        if sid in self.actions:
            return False
        ok, _reason, _power = self.view.can_execute(sid, {'action': 'calibrate'})
        if not ok:
            return False
        self.actions[sid] = {'action': 'calibrate'}
        return True

    def idle(self, sid: str) -> None:
        self.actions.setdefault(sid, {'action': 'idle'})

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

    def on_event(self, event: dict[str, Any], view: StepView) -> None:  # noqa: B027
        """Hook for planners that keep a precomputed schedule.

        Deliberately not abstract and deliberately empty: a planner that decides
        everything on the step has nothing to invalidate, and forcing it to
        write an empty override would say the opposite.
        """

    @abstractmethod
    def plan(self, view: StepView) -> dict[str, Action]:
        ...

    def metadata(self) -> dict[str, Any]:
        return {'algorithm': self.name, 'version': self.version,
                'goal': self.goal, 'parameters': dict(self.parameters)}
