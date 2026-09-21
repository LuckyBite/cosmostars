"""Verifiable grounds for saying a job cannot be completed.

The statement is strict about this: a claim that a job was impossible needs a
checkable basis, and the absence of a schedule found by our planner is not one.
Two certificates here are independent of any planner.

Single-job certificate
    A downlink job is bound to one satellite. Intersect its execution window
    with that satellite's contact schedule. If the intersection holds fewer
    steps than the job needs, no sequence of actions completes it.

Group certificate (Hall)
    Take the downlink jobs of one satellite whose windows all sit inside an
    interval. They compete for the contacts inside that interval only. If their
    total remaining work exceeds the contacts available there, at least that
    many work-steps must go unserved, whatever the planner does.

Events can only remove contact (close_downlink) or availability, never add it,
so a certificate issued at the start of a shift stays valid for the rest of it.
"""
from __future__ import annotations

from typing import Any

from .downlink import ceiling
from .view import Job, StepView

WINDOW_CERTIFICATE = 'contact_window_shorter_than_work'
GROUP_CERTIFICATE = 'satellite_contacts_oversubscribed'


def _window_certificates(view: StepView) -> list[dict[str, Any]]:
    out = []
    for job in view.all_jobs().values():
        if job['kind'] != 'downlink' or job['completed_step'] is not None:
            continue
        if job['deadline_step'] <= view.step:
            continue
        slots = view.downlink_slots(job, from_step=job['release_step'])
        if len(slots) < job['remaining_steps']:
            out.append({
                'certificate': WINDOW_CERTIFICATE,
                'job_id': job['id'],
                'satellite_id': job['eligible_satellites'][0],
                'priority': job['priority'],
                'value_usd': job['value_usd'],
                'window': [job['release_step'], job['deadline_step']],
                'contacts_in_window': len(slots),
                'work_required': job['remaining_steps'],
            })
    return out


def _group_certificates(view: StepView, proven: set[str]) -> list[dict[str, Any]]:
    by_satellite: dict[str, list[Job]] = {}
    for job in view.all_jobs().values():
        if job['kind'] != 'downlink' or job['completed_step'] is not None:
            continue
        if job['deadline_step'] <= view.step or job['id'] in proven:
            continue
        by_satellite.setdefault(job['eligible_satellites'][0], []).append(job)

    out = []
    for sid, jobs in sorted(by_satellite.items()):
        series = view.contact_series(sid, 'downlink')
        bounds = sorted({job['release_step'] for job in jobs} |
                        {job['deadline_step'] for job in jobs})
        best: dict[str, Any] | None = None
        for i, start in enumerate(bounds):
            for end in bounds[i + 1:]:
                inside = [job for job in jobs
                          if start <= job['release_step'] and job['deadline_step'] <= end]
                if len(inside) < 2:
                    continue
                demand = sum(job['remaining_steps'] for job in inside)
                supply = sum(1 for k in range(start, end)
                             if series[k] and view.available_at(sid, k))
                shortfall = demand - supply
                if shortfall > 0 and (best is None or shortfall > best['shortfall']):
                    best = {
                        'certificate': GROUP_CERTIFICATE,
                        'satellite_id': sid,
                        'interval': [start, end],
                        'jobs': sorted(job['id'] for job in inside),
                        'work_required': demand,
                        'contacts_in_interval': supply,
                        'shortfall': shortfall,
                    }
        if best is not None:
            out.append(best)
    return out


def analyse(view: StepView) -> dict[str, Any]:
    """Everything provable about what this shift cannot deliver."""
    window = _window_certificates(view)
    proven = {item['job_id'] for item in window}
    groups = _group_certificates(view, proven)
    lost_value = sum(item['value_usd'] for item in window)
    lost_critical = sum(1 for item in window if item['priority'] == 3)
    return {
        'built_at_step': view.step,
        'downlink_ceiling': ceiling(view),
        'impossible_jobs': window,
        'oversubscribed_satellites': groups,
        'totals': {
            'impossible_job_count': len(window),
            'impossible_critical_count': lost_critical,
            'impossible_value_usd': round(lost_value, 6),
            'satellites_with_group_shortfall': len(groups),
            'group_shortfall_work_steps': sum(item['shortfall'] for item in groups),
        },
    }
