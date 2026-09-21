"""Planners available to the service.

Two entries on purpose: the disclosed simple rule the statement asks us to
compare against, and the team planner. Both take the same goal and see the same
information, so a comparison between them is a comparison of method only.
"""
from __future__ import annotations

from .base import GOALS, Planner, StepPlan, check_goal, job_score
from .baseline_edf import EDFPlanner
from .smart import SmartPlanner
from .view import StepView

PLANNERS: dict[str, type[Planner]] = {
    EDFPlanner.name: EDFPlanner,
    SmartPlanner.name: SmartPlanner,
}

DEFAULT_PLANNER = SmartPlanner.name


def build_planner(name: str, goal: str, **parameters) -> Planner:
    if name not in PLANNERS:
        raise ValueError(f'Unknown planner {name!r}, expected one of {sorted(PLANNERS)}')
    return PLANNERS[name](goal=check_goal(goal), **parameters)


__all__ = ['GOALS', 'PLANNERS', 'DEFAULT_PLANNER', 'Planner', 'StepPlan', 'StepView',
           'EDFPlanner', 'SmartPlanner', 'build_planner', 'check_goal', 'job_score']
