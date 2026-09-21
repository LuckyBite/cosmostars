"""Planners available to the service.

Three entries on purpose. The disclosed simple rule the statement asks us to
compare against; the team planner; and the same team planner with one part
replaced — relay handed out by exact matching instead of greedily. All three
take the same goal and see the same information, so a comparison between them is
a comparison of method only, and the third isolates a single design decision.
"""
from __future__ import annotations

from .base import GOALS, Planner, StepPlan, check_goal, job_score
from .baseline_edf import EDFPlanner
from .matched import MatchedRelayPlanner
from .smart import SmartPlanner
from .view import StepView

PLANNERS: dict[str, type[Planner]] = {
    EDFPlanner.name: EDFPlanner,
    SmartPlanner.name: SmartPlanner,
    MatchedRelayPlanner.name: MatchedRelayPlanner,
}

DEFAULT_PLANNER = SmartPlanner.name


def build_planner(name: str, goal: str, **parameters) -> Planner:
    if name not in PLANNERS:
        raise ValueError(f'Unknown planner {name!r}, expected one of {sorted(PLANNERS)}')
    return PLANNERS[name](goal=check_goal(goal), **parameters)


__all__ = [
    'DEFAULT_PLANNER',
    'GOALS',
    'PLANNERS',
    'EDFPlanner',
    'MatchedRelayPlanner',
    'Planner',
    'SmartPlanner',
    'StepPlan',
    'StepView',
    'build_planner',
    'check_goal',
    'job_score',
]
