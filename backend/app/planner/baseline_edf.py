"""Baseline: earliest deadline first.

The statement asks for a simple, disclosed rule to compare against. This one is
it: walk satellites in id order, give each the admissible job with the nearest
deadline, calibrate when nothing else can be done. It carries no lookahead, so
it spends scarce ground contacts on whichever job happens to be urgent.
"""
from __future__ import annotations

from .base import Planner, StepPlan, job_score
from .view import Action, Job, StepView


class EDFPlanner(Planner):
    name = 'baseline-edf'
    version = '1.0'

    def __init__(self, goal: str = 'priority', calibrate_margin: int = 2) -> None:
        super().__init__(goal, calibrate_margin=calibrate_margin)
        self.calibrate_margin = calibrate_margin

    def _rank(self, job: Job) -> tuple[int, float]:
        return (job['deadline_step'], -job_score(job, self.goal))

    def plan(self, view: StepView) -> dict[str, Action]:
        view.refresh()
        plan = StepPlan(view)
        margin = self.calibrate_margin
        valid_for = view.model['calibration_valid_steps']
        for sid in view.satellite_ids:
            if not view.available(sid):
                plan.idle(sid, 'satellite_unavailable')
                continue
            if view.calibration_expired(sid) and plan.try_calibrate(sid):
                continue
            candidates = sorted(view.jobs_for(sid), key=self._rank)
            if any(plan.try_job(sid, job) for job in candidates):
                continue
            if view.calibration_age(sid) >= valid_for - margin and plan.try_calibrate(sid):
                continue
            plan.idle(sid)
        return plan.finish()
