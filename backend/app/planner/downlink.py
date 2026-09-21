"""Exact scheduling of the scarce resource: ground contacts.

Downlink is the binding constraint of this case. In the daily scenario the
constellation has 458 satellite-steps of ground contact against 410 steps of
downlink work, under a global cap of two simultaneous transmissions, and 210 of
344 jobs have exactly as many slots as they need. A greedy choice wastes slots
that no later step can recover, so the downlink schedule is built ahead as a
flow problem and only relay work is decided step by step.

Every downlink job is bound to exactly one satellite, so the assignment is a
pure b-matching: a job needs remaining_steps distinct slots drawn from its own
contact window, each satellite-step carries one job, and each step carries at
most downlink_parallel_limit jobs across the constellation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .base import job_score
from .flow import MaxFlow
from .view import Job, StepView

IMPOSSIBLE_WINDOW = 'contact_window_shorter_than_work'
DISPLACED = 'slot_taken_by_higher_ranked_job'


@dataclass
class DownlinkSchedule:
    """Which downlink job each satellite should serve at each future step."""

    by_step: dict[int, dict[str, str]] = field(default_factory=dict)
    selected: set[str] = field(default_factory=set)
    unreachable: list[dict[str, Any]] = field(default_factory=list)
    displaced: list[dict[str, Any]] = field(default_factory=list)
    built_at_step: int = 0

    def job_for(self, sid: str, step: int) -> str | None:
        return self.by_step.get(step, {}).get(sid)

    def as_dict(self) -> dict[str, Any]:
        return {
            'built_at_step': self.built_at_step,
            'selected_jobs': sorted(self.selected),
            'unreachable': self.unreachable,
            'displaced': self.displaced,
            'assignments': {str(k): v for k, v in sorted(self.by_step.items())},
        }


class _Network:
    """Flow network over the currently open downlink jobs."""

    def __init__(self, jobs: list[Job], slots: dict[str, list[int]], step_limit: int) -> None:
        self.jobs = jobs
        self.slots = slots
        self.step_limit = step_limit
        self.job_index = {job['id']: i for i, job in enumerate(jobs)}
        pairs = sorted({(job['eligible_satellites'][0], k)
                        for job in jobs for k in slots[job['id']]})
        self.pair_index = {pair: i for i, pair in enumerate(pairs)}
        steps = sorted({k for _, k in pairs})
        self.step_index = {k: i for i, k in enumerate(steps)}
        self.source = 0
        self.job_base = 1
        self.pair_base = self.job_base + len(jobs)
        self.step_base = self.pair_base + len(pairs)
        self.sink = self.step_base + len(steps)

    def solve(self, chosen: list[Job]) -> tuple[int, dict[str, list[int]]]:
        """Max flow over the chosen jobs; returns served units and the assignment."""
        net = MaxFlow(self.sink + 1)
        job_edges: dict[str, list[tuple[int, int]]] = {}
        for job in chosen:
            job_id = job['id']
            node = self.job_base + self.job_index[job_id]
            net.add_edge(self.source, node, job['remaining_steps'])
            sid = job['eligible_satellites'][0]
            job_edges[job_id] = []
            for k in self.slots[job_id]:
                pair_node = self.pair_base + self.pair_index[(sid, k)]
                edge_id = net.add_edge(node, pair_node, 1)
                job_edges[job_id].append((edge_id, k))
        for (sid, k), i in self.pair_index.items():
            net.add_edge(self.pair_base + i, self.step_base + self.step_index[k], 1)
        for k, i in self.step_index.items():
            net.add_edge(self.step_base + i, self.sink, self.step_limit)
        served = net.run(self.source, self.sink)
        assignment = {job['id']: [k for edge_id, k in job_edges[job['id']]
                                  if net.flow_on(edge_id)] for job in chosen}
        return served, assignment


def _open_downlink_jobs(view: StepView) -> tuple[list[Job], dict[str, list[int]]]:
    """Every downlink job still ahead of us, released or not.

    The schedule is a commitment over the rest of the shift, so jobs that open
    later belong in it from the start: their contacts are exactly the ones a
    step-by-step rule would have already spent on something cheaper.
    """
    jobs: list[Job] = []
    slots: dict[str, list[int]] = {}
    for job in view.all_jobs().values():
        if job['kind'] != 'downlink' or job['completed_step'] is not None:
            continue
        if job['deadline_step'] <= view.step:
            continue
        jobs.append(job)
        slots[job['id']] = view.downlink_slots(job)
    return jobs, slots


def build_schedule(view: StepView, goal: str) -> DownlinkSchedule:
    """Pick the most valuable set of downlink jobs that can all be completed.

    Jobs are offered in goal order and kept only if the whole selection stays
    feasible, so a cheap job never costs a critical one its only contact. With
    single-step jobs this ordering is provably optimal; with multi-step jobs it
    is a lower bound, and the ceiling below reports the distance to the relaxed
    flow optimum.
    """
    schedule = DownlinkSchedule(built_at_step=view.step)
    candidates, slots = _open_downlink_jobs(view)
    open_jobs: list[Job] = []
    for job in candidates:
        window = slots[job['id']]
        if len(window) < job['remaining_steps']:
            schedule.unreachable.append({
                'job_id': job['id'], 'reason': IMPOSSIBLE_WINDOW,
                'satellite_id': job['eligible_satellites'][0],
                'slots_available': len(window), 'work_remaining': job['remaining_steps'],
                'deadline_step': job['deadline_step'], 'priority': job['priority'],
                'value_usd': job['value_usd'],
            })
        else:
            open_jobs.append(job)
    if not open_jobs:
        return schedule

    network = _Network(open_jobs, slots, view.model['downlink_parallel_limit'])
    ordered = sorted(open_jobs, key=lambda j: (-job_score(j, goal), j['deadline_step'], j['id']))
    chosen: list[Job] = []
    need = 0
    assignment: dict[str, list[int]] = {}
    for job in ordered:
        trial_jobs = chosen + [job]
        served, trial = network.solve(trial_jobs)
        if served == need + job['remaining_steps']:
            chosen, need, assignment = trial_jobs, served, trial
        else:
            schedule.displaced.append({
                'job_id': job['id'], 'reason': DISPLACED,
                'satellite_id': job['eligible_satellites'][0],
                'priority': job['priority'], 'value_usd': job['value_usd'],
            })
    for job in chosen:
        job_id = job['id']
        sid = job['eligible_satellites'][0]
        schedule.selected.add(job_id)
        for k in assignment[job_id]:
            schedule.by_step.setdefault(k, {})[sid] = job_id
    return schedule


def ceiling(view: StepView) -> dict[str, Any]:
    """Upper bound on downlink work that any planner could still perform.

    This is the relaxed flow optimum: it ignores the all-or-nothing payment
    rule, so no strategy can beat it. That makes it a safe reference for the
    report rather than a claim about one particular schedule.
    """
    jobs, slots = _open_downlink_jobs(view)
    reachable = [job for job in jobs if len(slots[job['id']]) >= job['remaining_steps']]
    demanded = sum(job['remaining_steps'] for job in jobs)
    if not reachable:
        return {'work_steps_demanded': demanded, 'work_steps_schedulable': 0,
                'jobs_open': len(jobs), 'jobs_unreachable_by_window': len(jobs)}
    network = _Network(reachable, slots, view.model['downlink_parallel_limit'])
    served, _ = network.solve(reachable)
    return {
        'work_steps_demanded': demanded,
        'work_steps_schedulable': served,
        'jobs_open': len(jobs),
        'jobs_unreachable_by_window': len(jobs) - len(reachable),
    }
