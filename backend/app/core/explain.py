"""Why one job did not happen, separated into layers that answer differently.

The statement asks participants to tell the limits of the task apart from the
limits of their own algorithm, and to back a claim of impossibility with
something checkable. Those are different answers to one click, so this module
keeps them apart instead of merging them into a verdict:

1. **Impossible against the data.** A certificate from ``planner.feasibility``,
   issued against the scenario rather than against our schedule. The single-job
   certificate rules this job out on its own. The group certificate is weaker
   and is reported as weaker: it proves that the downlink jobs of one satellite
   inside an interval cannot all be served, not that this particular job
   cannot. Which of them gives way is the planner's choice, and layer 2 says so.
2. **Lost the contest for a resource.** Ground contact: which job holds, or
   held, the contacts this job needed. Ahead of the executed frontier that is
   read from the committed schedule, behind it from the execution log, so the
   answer survives the deadline instead of vanishing with the window. While the
   window is still open the schedule is re-solved with this job forced in,
   which prices the trade-off rather than asserting it. Relay: what the
   eligible satellites were doing on the steps this job could have used, and
   why the idle ones stayed idle — too late to finish, below the reserve,
   calibration expired, unavailable — each reason counted from the log.
3. **Refused by the satellite.** The command was issued and the library refused
   it: energy reserve, thermal limit, calibration, contact, ground capacity.
   The reason comes out of the execution log, not out of our reasoning.

What the eligible satellites did instead is reported alongside, because an idle
satellite holding an open contact is exactly the question an expert asks next.
"""
from __future__ import annotations

import bisect
from collections import Counter
from typing import TYPE_CHECKING, Any

from ..planner import downlink, feasibility
from ..planner.smart import SmartPlanner
from .errors import NotFound

if TYPE_CHECKING:  # pragma: no cover - the cycle only matters for type checkers
    from .run import Run

MAX_ROWS = 400
MAX_RIVALS = 8


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


def _executed_job(row: dict[str, Any] | None) -> str | None:
    """Job a log row actually worked on; None for idle, calibration and refusals."""
    if row is None or row['executed'] != 'job':
        return None
    job_id = (row.get('requested') or {}).get('job_id')
    return job_id if isinstance(job_id, str) else None


def _downlink_contest(run: Run, job: dict[str, Any]) -> dict[str, Any] | None:
    """Who holds, or held, the contacts this job needed, and what taking them back costs.

    Steps already executed are read from the log, steps ahead from the committed
    schedule when the planner keeps one. The log side is what keeps the answer
    alive after the deadline: the schedule only ever looks forward.
    """
    if job['kind'] != 'downlink' or not job['eligible_satellites']:
        return None
    view = run.view
    schedule = run.planner.schedule if isinstance(run.planner, SmartPlanner) else None
    sid = job['eligible_satellites'][0]
    closed = job['deadline_step'] <= run.step
    rows = {row['step']: row for row in run.session.env.trace if row['satellite_id'] == sid}
    taken: list[dict[str, Any]] = []
    slots = worked = free_past = free_ahead = 0
    for step in range(job['release_step'], job['deadline_step']):
        if not (view.contact(sid, 'downlink', step) and view.available_at(sid, step)):
            continue
        slots += 1
        if step < run.step:
            holder, source = _executed_job(rows.get(step)), 'log'
        else:
            holder = schedule.job_for(sid, step) if schedule is not None else None
            source = 'schedule'
        if holder == job['id']:
            worked += 1
        elif holder is None:
            if step < run.step:
                free_past += 1
            else:
                free_ahead += 1
        else:
            rival = view.job(holder)
            taken.append({
                'step': step, 'satellite_id': sid, 'taken_by': holder, 'source': source,
                'priority': rival['priority'] if rival else None,
                'value_usd': rival['value_usd'] if rival else None,
            })
    return {
        'kind': 'downlink',
        'closed': closed,
        'planned': schedule is not None,
        'slots_in_window': slots,
        'slots_worked': worked,
        'slots_free': free_past + free_ahead,
        'slots_free_past': free_past,
        'slots_taken': taken[:MAX_ROWS],
        'slots_taken_total': len(taken),
        'selected': schedule is not None and job['id'] in schedule.selected,
        'counterfactual': (None if closed or schedule is None
                           else _counterfactual(run, job, schedule)),
    }


def _counterfactual(run: Run, job: dict[str, Any],
                    schedule: downlink.DownlinkSchedule) -> dict[str, Any] | None:
    """Re-solve the schedule with this job forced in; report what falls out.

    This is the price of the trade-off, measured rather than argued. It is only
    asked for a job we did not serve and whose window is still open: for a
    served one there is nothing to buy, and for a closed one nothing to re-plan.
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


def _relay_contest(run: Run, job: dict[str, Any]) -> dict[str, Any] | None:
    """What the eligible satellites did on the steps this relay job could have used.

    Relay is decided on the step, so there is no schedule to read a rival from;
    the log is the record. Every satellite-step in the executed part of the
    window is classified: spent on another job, spent calibrating, idle without
    relay contact, or idle with contact — and an idle satellite in contact is
    explained by the state it was in: announced unavailable, too late to finish
    this job by its deadline, below the energy reserve, calibration expired, or
    none of these.
    """
    if job['kind'] != 'relay':
        return None
    env = run.session.env
    model = env.s['model']
    valid = model['calibration_valid_steps']
    lo, hi = job['release_step'], min(job['deadline_step'], run.step)
    eligible = set(job['eligible_satellites'])
    progress = sorted(row['step'] for row in env.trace if _executed_job(row) == job['id'])
    rivals: Counter[str] = Counter()
    busy = calibrating = no_contact = 0
    idle = {'unavailable': 0, 'too_late': 0, 'below_reserve': 0, 'calibration_expired': 0,
            'other': 0}
    for row in env.trace:
        step, sid = row['step'], row['satellite_id']
        if not lo <= step < hi or sid not in eligible:
            continue
        holder = _executed_job(row)
        if holder == job['id']:
            continue
        if holder is not None:
            busy += 1
            rivals[holder] += 1
            continue
        if row['executed'] == 'calibrate':
            calibrating += 1
            continue
        if not run.view.contact(sid, 'relay', step):
            no_contact += 1
            continue
        reserve_wh = env.sats[sid]['capacity_wh'] * model['reserve_soc_pct'] / 100
        remaining_then = job['work_steps'] - bisect.bisect_left(progress, step)
        if not run.view.available_at(sid, step):
            idle['unavailable'] += 1
        elif job['deadline_step'] - step < remaining_then:
            idle['too_late'] += 1
        elif row['energy_before_wh'] < reserve_wh - 1e-9 or row['below_reserve']:
            idle['below_reserve'] += 1
        elif row['calibration_age_steps'] - 1 >= valid:
            idle['calibration_expired'] += 1
        else:
            idle['other'] += 1
    return {
        'kind': 'relay',
        'closed': job['deadline_step'] <= run.step,
        'window_executed': [lo, max(lo, hi)],
        'busy_steps': busy,
        'calibrate_steps': calibrating,
        'rivals': [{
            'job_id': rival, 'steps': count,
            'priority': (env.jobs.get(rival) or {}).get('priority'),
            'value_usd': (env.jobs.get(rival) or {}).get('value_usd'),
        } for rival, count in rivals.most_common(MAX_RIVALS)],
        'rivals_total': len(rivals),
        'idle_in_contact': idle,
        'idle_in_contact_total': sum(idle.values()),
        'idle_no_contact': no_contact,
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
             contest: dict[str, Any] | None, refused: list[dict[str, Any]]) -> str:
    if job['completed_step'] is not None:
        return 'completed'
    if certificate is not None:
        # The window certificate is about this job; the group certificate is
        # about the satellite's jobs together, and must not read as if it were.
        return ('impossible_by_data'
                if certificate['certificate'] == feasibility.WINDOW_CERTIFICATE
                else 'group_shortfall')
    if refused:
        return 'refused_by_satellite'
    closed = job['deadline_step'] <= step
    if contest is not None:
        if contest['kind'] == 'downlink':
            if not contest['selected'] and contest['slots_taken_total']:
                return 'outcompeted'
        elif closed:
            # Relay is judged once the window is over: until then a job that has
            # not started is simply waiting its turn.
            starved = (contest['idle_in_contact']['below_reserve']
                       + contest['idle_in_contact']['calibration_expired'])
            if contest['busy_steps'] and contest['busy_steps'] >= starved:
                return 'outcompeted'
            if starved:
                return 'resource_starved'
    if closed:
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
    contest = (_downlink_contest(run, job) if job['kind'] == 'downlink'
               else _relay_contest(run, job))
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
        'verdict': _verdict(job, run.step, certificate, contest, refused),
        'impossible': certificate,
        'competition': contest,
        'refusals': {'rows': refused, 'total': len(refused), 'dominant_reason': dominant},
        'progress': {'rows': worked, 'total': len(worked)},
        'instead': _instead(run, job),
    }
