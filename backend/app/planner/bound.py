"""Upper bounds on how much work any planner could have done.

The downlink sub-problem is solved exactly, so its ceiling is part of the
schedule itself. Relay is not: it is decided step by step, and a step-by-step
rule can leave work on the table without anyone noticing. A claim about how
good it is therefore needs a yardstick that does not come from our own planner.

The bound here is a relaxation, and it is important to say exactly what it
relaxes. It keeps:

* contact — a job is only servable on a satellite-step where its kind of link
  is open, the satellite is eligible for it and not announced unavailable;
* the satellite's time — one satellite does one thing per step;
* the amount of work each job needs.

It drops energy, temperature, calibration, the global cap of two simultaneous
transmissions, and the rule that only finished jobs are paid. Dropping
constraints can only raise the optimum, so no planner — ours or anyone's — can
beat the number that comes out. That is what makes it a fair yardstick and also
what makes it loose: the gap between it and reality is partly the algorithm and
partly physics the bound refuses to look at.

Counted in work-steps rather than jobs. Bounding *completed* jobs exactly is a
different and much harder question, and quietly answering the easy one while
labelling it the hard one is the kind of thing this file exists to avoid.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .flow import MaxFlow
from .view import Job, StepView


def _servable_pairs(view: StepView, job: Job) -> Iterable[tuple[str, int]]:
    """Satellite-steps where this job could be worked, by contact alone."""
    kind = job['kind']
    start = max(job['release_step'], view.step)
    for sid in job['eligible_satellites']:
        series = view.contact_series(sid, kind)
        for step in range(start, job['deadline_step']):
            if step < len(series) and series[step] and view.available_at(sid, step):
                yield sid, step


def work_ceiling(view: StepView, kinds: tuple[str, ...] = ('downlink', 'relay')) -> dict[str, Any]:
    """Most work-steps of the named kinds that contact and time allow.

    One flow solve. The satellite-step is the scarce unit and carries capacity
    one, which is what couples downlink and relay: a satellite transmitting to
    the ground is not relaying at the same step.
    """
    jobs = [job for job in view.all_jobs().values()
            if job['kind'] in kinds
            and job['completed_step'] is None
            and job['deadline_step'] > view.step
            and job['remaining_steps'] > 0]
    if not jobs:
        return {'kinds': list(kinds), 'jobs_open': 0, 'work_steps_demanded': 0,
                'work_steps_schedulable': 0, 'satellite_steps_used': 0}

    pairs: dict[tuple[str, int], int] = {}
    edges: list[tuple[int, tuple[str, int]]] = []
    for index, job in enumerate(jobs):
        for pair in _servable_pairs(view, job):
            if pair not in pairs:
                pairs[pair] = len(pairs)
            edges.append((index, pair))

    source = 0
    job_base = 1
    pair_base = job_base + len(jobs)
    sink = pair_base + len(pairs)
    net = MaxFlow(sink + 1)
    for index, job in enumerate(jobs):
        net.add_edge(source, job_base + index, job['remaining_steps'])
    for index, pair in edges:
        net.add_edge(job_base + index, pair_base + pairs[pair], 1)
    for slot in pairs.values():
        net.add_edge(pair_base + slot, sink, 1)

    served = net.run(source, sink)
    return {
        'kinds': list(kinds),
        'jobs_open': len(jobs),
        'work_steps_demanded': sum(job['remaining_steps'] for job in jobs),
        'work_steps_schedulable': served,
        'satellite_steps_used': len(pairs),
    }


def spent(run: Any) -> dict[str, Any]:
    """Work-steps the shift actually spent, and how much of it was wasted.

    Work put into a job that never finished is not a result: the case pays for
    completion only. So the honest numerator is spent minus wasted, per kind.
    """
    env = run.session.env
    kinds = {job_id: job['kind'] for job_id, job in env.jobs.items()}
    used = {'downlink': 0, 'relay': 0}
    for row in env.trace:
        if row['executed'] != 'job':
            continue
        job_id = (row.get('requested') or {}).get('job_id')
        kind = kinds.get(job_id)
        if kind in used:
            used[kind] += 1
    wasted = {'downlink': 0, 'relay': 0}
    for job in env.jobs.values():
        if job['completed_step'] is None and job['deadline_step'] <= env.k:
            done = job['work_steps'] - job['remaining_steps']
            if job['kind'] in wasted:
                wasted[job['kind']] += done
    return {
        'spent': used,
        'wasted': wasted,
        'useful': {kind: used[kind] - wasted[kind] for kind in used},
    }


def missed_capacity(run: Any, kind: str = 'relay') -> dict[str, Any]:
    """Satellite-steps the shift could have worked and did not.

    Where :func:`work_ceiling` relaxes physics, this counts only what was
    actually available at the time: the satellite was idle, its link was open,
    its charge was above the reserve, its calibration was still valid, and an
    eligible job of this kind had work left that no other satellite was doing
    at that step. Nothing here is hypothetical, which makes it the tighter and
    the more damning of the two numbers.

    A step counted here is an opportunity, not a completed job: the case pays
    for finished work only, so filling one would not necessarily have paid.
    """
    env = run.session.env
    model = env.s['model']
    reserve = model['reserve_soc_pct']
    valid = model['calibration_valid_steps']

    jobs = [job for job in env.jobs.values() if job['kind'] == kind]
    remaining = {job['id']: job['work_steps'] for job in jobs}
    by_satellite: dict[str, list[Job]] = {}
    for job in jobs:
        for sid in job['eligible_satellites']:
            by_satellite.setdefault(sid, []).append(job)

    rows_by_step: dict[int, list[dict[str, Any]]] = {}
    for row in env.trace:
        rows_by_step.setdefault(row['step'], []).append(row)

    missed = 0
    reasons = {'below_reserve': 0, 'calibration_expired': 0, 'no_contact': 0, 'no_open_work': 0}
    steps_touched: set[int] = set()
    for step in sorted(rows_by_step):
        rows = rows_by_step[step]
        busy = {(row.get('requested') or {}).get('job_id') for row in rows
                if row['executed'] == 'job'}
        for row in rows:
            if row['executed'] != 'idle':
                continue
            sid = row['satellite_id']
            series = env.s['environment'][sid][kind + '_available']
            if not (step < len(series) and series[step]):
                reasons['no_contact'] += 1
                continue
            available = [job for job in by_satellite.get(sid, ())
                         if job['release_step'] <= step < job['deadline_step']
                         and remaining[job['id']] > 0 and job['id'] not in busy]
            if not available:
                reasons['no_open_work'] += 1
            elif 100 * row['energy_before_wh'] / env.sats[sid]['capacity_wh'] < reserve:
                reasons['below_reserve'] += 1
            elif row['calibration_age_steps'] >= valid:
                reasons['calibration_expired'] += 1
            else:
                missed += 1
                steps_touched.add(step)
        for job_id in busy:
            if job_id in remaining:
                remaining[job_id] -= 1

    return {
        'kind': kind,
        'missed_satellite_steps': missed,
        'distinct_steps': len(steps_touched),
        'idle_explained_by': reasons,
    }
