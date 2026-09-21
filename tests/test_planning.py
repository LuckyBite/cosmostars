"""Checks on the planner and the accounting it produces."""
from __future__ import annotations

import collections

import pytest

from backend.app.core import scenarios
from backend.app.core.errors import BadRequest
from backend.app.core.run import Run
from backend.app.planner import feasibility


def make_run(key: str = 'P01_intro', planner: str = 'cosmostars', goal: str = 'priority') -> Run:
    return Run(scenarios.get(key), key, planner_name=planner, goal=goal)


def test_shared_limits_are_respected_by_the_planner():
    """The library resolves conflicts, but the planner must not create them."""
    run = make_run('P02_shift')
    run.advance_to(run.total_steps)
    per_step_downlink: collections.Counter = collections.Counter()
    per_step_jobs: dict[tuple[int, str], int] = collections.Counter()
    for row in run.session.env.trace:
        if row['executed'] != 'job':
            continue
        job = run.session.env.jobs[row['requested']['job_id']]
        per_step_jobs[(row['step'], job['id'])] += 1
        if job['kind'] == 'downlink':
            per_step_downlink[row['step']] += 1
    limit = run.session.env.s['model']['downlink_parallel_limit']
    assert max(per_step_downlink.values(), default=0) <= limit
    assert max(per_step_jobs.values(), default=0) <= 1


def test_no_command_is_ever_refused():
    """A planner that asks for impossible work wastes the step it asked on."""
    run = make_run('P02_shift')
    run.advance_to(run.total_steps)
    assert run.session.summary()['blocked_command_count'] == 0


def test_certified_jobs_are_never_completed():
    """The infeasibility certificate must hold for the whole shift, not just now."""
    run = make_run('P02_shift')
    certified = {item['job_id'] for item in feasibility.analyse(run.view)['impossible_jobs']}
    assert certified, 'P02 is known to contain unreachable downlink jobs'
    run.advance_to(run.total_steps)
    completed = {job_id for job_id, job in run.session.env.jobs.items()
                 if job['completed_step'] is not None}
    assert certified.isdisjoint(completed)


def test_planner_reaches_the_certified_ceiling_on_p02():
    """Everything not certified impossible is in fact completed on the base shift."""
    run = make_run('P02_shift')
    impossible = len(feasibility.analyse(run.view)['impossible_jobs'])
    run.advance_to(run.total_steps)
    summary = run.session.summary()
    assert summary['jobs_completed'] == summary['jobs_total'] - impossible
    assert summary['work_steps_in_missed_jobs'] == 0


def test_team_planner_beats_the_baseline_under_energy_scarcity():
    """The comparison the statement asks for, on the scenario that stresses it."""
    smart = make_run('P03_energy', 'cosmostars')
    smart.advance_to(smart.total_steps)
    base = make_run('P03_energy', 'baseline-edf')
    base.advance_to(base.total_steps)
    assert smart.session.summary()['critical_jobs_completed_on_time'] > \
        base.session.summary()['critical_jobs_completed_on_time']
    assert smart.session.summary()['below_reserve_satellite_steps'] < \
        base.session.summary()['below_reserve_satellite_steps']


def test_goals_trade_priority_against_revenue_under_overload():
    """With more demand than capacity the two goals must actually differ."""
    priority = make_run('P04_demand', 'cosmostars', 'priority')
    priority.advance_to(priority.total_steps)
    revenue = make_run('P04_demand', 'cosmostars', 'revenue')
    revenue.advance_to(revenue.total_steps)
    assert priority.session.summary()['critical_jobs_completed_on_time'] > \
        revenue.session.summary()['critical_jobs_completed_on_time']
    assert revenue.session.summary()['revenue_usd'] > priority.session.summary()['revenue_usd']


def test_advance_never_recomputes_history():
    run = make_run()
    run.advance(5)
    with pytest.raises(BadRequest, match='never recomputed'):
        run.advance_to(2)
