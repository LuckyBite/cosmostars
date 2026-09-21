"""Why one job did not happen, separated into layers that answer differently.

The statement asks participants to tell the limits of the task apart from the
limits of their own algorithm, and to back a claim of impossibility with
something checkable. Those are three different answers to one click, so this
module keeps them apart instead of merging them into a verdict:

1. **Impossible against the data.** A certificate from ``planner.feasibility``,
   issued against the scenario rather than against our schedule. Nothing any
   planner does completes this job.
2. **Lost the contest for a slot.** The job was reachable, and the contact it
   needed went to a better-ranked one. We name the job that took it and, by
   re-solving with this job forced in, what serving it instead would have cost.
3. **Refused by the satellite.** The command was issued and the library refused
   it: energy reserve, thermal limit, calibration, contact, ground capacity.
   The reason comes out of the execution log, not out of our reasoning.

What the satellite did instead is reported alongside, because an idle satellite
holding an open contact is exactly the question an expert asks next.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..planner import downlink, feasibility
from ..planner.smart import SmartPlanner
from .errors import NotFound

if TYPE_CHECKING:  # pragma: no cover - the cycle only matters for type checkers
    from .run import Run

MAX_ROWS = 400


def _certificate(view: Any, job: dict[str, Any]) -> dict[str, Any] | None:
    """The planner-independent proof, if the data already rules this job out.

    The single-job test is asked directly so that a missed job keeps its proof:
    the group report only covers jobs whose deadline is still ahead.
    """
    closed = job['deadline_step'] <= view.step
    direct = feasibility.job_certificate(view, job, retrospective=closed)
    if direct is not None:
        return direct
    if closed or job['kind'] != 'downlink':
        return None
    satellite_id = job['eligible_satellites'][0] if job['eligible_satellites'] else ''
    for item in feasibility.analyse(view)['oversubscribed_satellites']:
        if item['satellite_id'] == satellite_id and job['id'] in item['jobs']:
            return item
    return None


def _competition(run: Run, job: dict[str, Any]) -> dict[str, Any] | None:
    """Who holds the contacts this job needed, and what taking them back costs."""
    if job['kind'] != 'downlink' or not isinstance(run.planner, SmartPlanner):
        return None
    schedule = run.planner.schedule
    if schedule is None:
        return None
    view = run.view
    sid = job['eligible_satellites'][0]
    slots = view.downlink_slots(job)
    held = []
    free = 0
    for step in slots:
        holder = schedule.job_for(sid, step)
        if holder is None:
            free += 1
            continue
        if holder == job['id']:
            continue
        rival = view.job(holder)
        held.append({
            'step': step,
            'satellite_id': sid,
            'taken_by': holder,
            'priority': rival['priority'] if rival else None,
            'value_usd': rival['value_usd'] if rival else None,
        })
    return {
        'slots_in_window': len(slots),
        'slots_free': free,
        'slots_taken': held[:MAX_ROWS],
        'slots_taken_total': len(held),
        'selected': job['id'] in schedule.selected,
        'counterfactual': _counterfactual(run, job, schedule),
    }


def _counterfactual(run: Run, job: dict[str, Any],
                    schedule: downlink.DownlinkSchedule) -> dict[str, Any] | None:
    """Re-solve the schedule with this job forced in; report what falls out.

    This is the price of the trade-off, measured rather than argued. It is only
    asked for a job we did not serve: for a served one there is nothing to buy.
    """
    if job['id'] in schedule.selected or job['completed_step'] is not None:
        return None
    forced = downlink.build_schedule(run.view, run.goal, forced=(job['id'],))
    if job['id'] not in forced.selected:
        return {'servable': False, 'reason': 'no_feasible_assignment_even_when_forced'}
    lost_ids = sorted(schedule.selected - forced.selected)
    lost = [run.view.job(job_id) for job_id in lost_ids]
    return {
        'servable': True,
        'jobs_dropped': [{
            'job_id': item['id'], 'priority': item['priority'],
            'value_usd': item['value_usd'], 'work_steps': item['work_steps'],
        } for item in lost if item is not None][:MAX_ROWS],
        'jobs_dropped_count': len(lost_ids),
        'value_given_up_usd': round(sum(item['value_usd'] for item in lost if item), 6),
        'critical_given_up': sum(1 for item in lost if item and item['priority'] == 3),
        'value_gained_usd': round(float(job['value_usd']), 6),
        'critical_gained': 1 if job['priority'] == 3 else 0,
    }


def _from_log(run: Run, job: dict[str, Any]) -> tuple[list[dict[str, Any]],
                                                        list[dict[str, Any]]]:
    """Rows of the execution log that name this job: refused and progressed."""
    refused: list[dict[str, Any]] = []
    worked: list[dict[str, Any]] = []
    for row in run.session.env.trace:
        requested = row.get('requested') or {}
        if requested.get('job_id') != job['id']:
            continue
        entry = {'step': row['step'], 'satellite_id': row['satellite_id'],
                 'reason': row['reason'], 'executed': row['executed']}
        (worked if row['executed'] == 'job' else refused).append(entry)
    return refused[:MAX_ROWS], worked[:MAX_ROWS]


def _instead(run: Run, job: dict[str, Any]) -> dict[str, Any]:
    """What the eligible satellites were doing across this job's window."""
    lo, hi = job['release_step'], min(job['deadline_step'], run.step)
    eligible = set(job['eligible_satellites'])
    kind = 'downlink' if job['kind'] == 'downlink' else 'relay'
    by_action: dict[str, int] = {}
    idle_in_contact: list[dict[str, Any]] = []
    for row in run.session.env.trace:
        if not lo <= row['step'] < hi or row['satellite_id'] not in eligible:
            continue
        by_action[row['executed']] = by_action.get(row['executed'], 0) + 1
        if row['executed'] != 'job' and run.view.contact(row['satellite_id'], kind, row['step']):
            idle_in_contact.append({'step': row['step'], 'satellite_id': row['satellite_id'],
                                    'executed': row['executed'], 'reason': row['reason']})
    return {
        'window': [lo, hi],
        'satellite_steps_by_action': by_action,
        'idle_while_in_contact': idle_in_contact[:MAX_ROWS],
        'idle_while_in_contact_total': len(idle_in_contact),
    }


def _verdict(job: dict[str, Any], step: int, certificate: dict[str, Any] | None,
             competition: dict[str, Any] | None, refused: list[dict[str, Any]]) -> str:
    if job['completed_step'] is not None:
        return 'completed'
    if certificate is not None:
        return 'impossible_by_data'
    if refused:
        return 'refused_by_satellite'
    if competition is not None and not competition['selected'] and competition['slots_taken']:
        return 'outcompeted'
    if job['deadline_step'] <= step:
        return 'missed_without_attempt'
    if job['work_steps'] != job['remaining_steps']:
        return 'in_progress'
    return 'open'


def explain(run: Run, job_id: str) -> dict[str, Any]:
    """Everything the service can prove about the fate of one job."""
    run.view.refresh()
    job = run.view.job(job_id)
    if job is None:
        raise NotFound(f'Unknown job {job_id!r}')
    certificate = _certificate(run.view, job)
    competition = _competition(run, job)
    refused, worked = _from_log(run, job)
    dominant = max({row['reason'] for row in refused}, default=None,
                   key=lambda reason: sum(1 for row in refused if row['reason'] == reason))
    return {
        'job_id': job_id,
        'at_step': run.step,
        'job': {
            'kind': job['kind'], 'priority': job['priority'], 'value_usd': job['value_usd'],
            'window': [job['release_step'], job['deadline_step']],
            'work_steps': job['work_steps'], 'remaining_steps': job['remaining_steps'],
            'progress_steps': job['work_steps'] - job['remaining_steps'],
            'eligible_satellites': job['eligible_satellites'],
            'completed_step': job['completed_step'],
        },
        'verdict': _verdict(job, run.step, certificate, competition, refused),
        'impossible': certificate,
        'competition': competition,
        'refusals': {'rows': refused, 'total': len(refused), 'dominant_reason': dominant},
        'progress': {'rows': worked, 'total': len(worked)},
        'instead': _instead(run, job),
    }
