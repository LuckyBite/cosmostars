"""The team planner: exact ahead-of-time downlink, greedy relay on top.

The two resources behave nothing alike. Ground contact is almost absent (three
percent of satellite-steps) and capped at two transmissions per step, so it has
to be committed ahead or it is lost. Relay contact is available almost always,
so relay work is limited by satellite time, energy and calibration instead, and
is decided step by step where the actual state is known.

The downlink schedule is rebuilt only when reality diverges from it: on an
event, on a goal switch, or when a committed transmission was refused.
"""
from __future__ import annotations

from typing import Any

from . import downlink
from .base import CRITICAL_PRIORITY, Planner, StepPlan, job_score
from .view import Action, Job, StepView

UNREACHABLE_RELAY = 'not_enough_steps_before_deadline'


class SmartPlanner(Planner):
    name = 'cosmostars'
    version = '1.0'

    def __init__(self, goal: str = 'priority', calibration_lead: int = 6,
                 relay_soc_floor_pct: float = 0.0) -> None:
        super().__init__(goal, calibration_lead=calibration_lead,
                         relay_soc_floor_pct=relay_soc_floor_pct)
        self.calibration_lead = calibration_lead
        self.relay_soc_floor_pct = relay_soc_floor_pct
        self._schedule: downlink.DownlinkSchedule | None = None
        self._stale = True
        self._rebuilds = 0

    # --- schedule upkeep -------------------------------------------------
    def set_goal(self, goal: str) -> None:
        super().set_goal(goal)
        self._stale = True

    def on_event(self, event: dict[str, Any], view: StepView) -> None:
        self._stale = True

    @property
    def schedule(self) -> downlink.DownlinkSchedule | None:
        return self._schedule

    def _ensure_schedule(self, view: StepView) -> downlink.DownlinkSchedule:
        if self._stale or self._schedule is None:
            self._schedule = downlink.build_schedule(view, self.goal)
            self._rebuilds += 1
            self._stale = False
        return self._schedule

    # --- step composition -------------------------------------------------
    def plan(self, view: StepView) -> dict[str, Action]:
        view.refresh()
        schedule = self._ensure_schedule(view)
        plan = StepPlan(view)
        self._place_downlink(view, plan, schedule)
        self._place_calibration(view, plan, schedule)
        self._place_relay(view, plan)
        return plan.finish()

    def _place_downlink(self, view: StepView, plan: StepPlan,
                        schedule: downlink.DownlinkSchedule) -> None:
        """Honour the committed transmissions first; they cannot be rescheduled."""
        for sid, job_id in schedule.by_step.get(view.step, {}).items():
            job = view.job(job_id)
            if job is None or job['completed_step'] is not None:
                continue
            if not plan.try_job(sid, job):
                # The commitment failed against the real state: energy, thermal
                # or an outage. The remaining slots have to be reassigned.
                self._stale = True

    def _place_calibration(self, view: StepView, plan: StepPlan,
                           schedule: downlink.DownlinkSchedule) -> None:
        """Calibrate before a satellite is needed, not after it is refused."""
        valid_for = view.model['calibration_valid_steps']
        for sid in view.satellite_ids:
            if sid in plan.actions or not view.available(sid):
                continue
            age = view.calibration_age(sid)
            if age >= valid_for:
                plan.try_calibrate(sid)
                continue
            if self._needs_calibration_soon(view, schedule, sid, age, valid_for):
                plan.try_calibrate(sid)

    def _needs_calibration_soon(self, view: StepView, schedule: downlink.DownlinkSchedule,
                                sid: str, age: int, valid_for: int) -> bool:
        """True when a committed downlink would fall outside the calibration window."""
        expires_at = view.step + (valid_for - age)
        horizon = min(expires_at + self.calibration_lead, view.total_steps)
        for k in range(expires_at, horizon):
            if schedule.job_for(sid, k) is not None:
                return True
        return False

    def _place_relay(self, view: StepView, plan: StepPlan) -> None:
        """Fill the remaining satellite time with the most valuable relay work."""
        step = view.step
        candidates: list[Job] = []
        for job in view.open_jobs():
            if job['kind'] != 'relay' or job['completed_step'] is not None:
                continue
            if job['deadline_step'] - step < job['remaining_steps']:
                continue  # cannot finish in time even with a free satellite
            candidates.append(job)
        candidates.sort(key=lambda j: self._relay_rank(view, j))
        for job in candidates:
            if not plan.downlink_slots_left and job['kind'] == 'downlink':
                continue
            self._assign_relay(view, plan, job)

    def _relay_rank(self, view: StepView, job: Job) -> tuple[int, float, int, str]:
        """Urgent work first, then goal value; slack breaks the remaining ties."""
        slack = view.slack(job)
        return (0 if slack <= 0 else 1, -job_score(job, self.goal), slack, job['id'])

    def _assign_relay(self, view: StepView, plan: StepPlan, job: Job) -> bool:
        free = [sid for sid in job['eligible_satellites']
                if sid not in plan.actions and view.available(sid)]
        if not free:
            return False
        # Spend the fullest battery first: it keeps the tighter ones in reserve
        # for the jobs whose eligibility list is shorter.
        free.sort(key=lambda sid: -view.soc_pct(sid))
        for sid in free:
            if view.soc_pct(sid) < self.relay_soc_floor_pct:
                continue
            if plan.try_job(sid, job):
                return True
        return False

    def metadata(self) -> dict[str, Any]:
        data = super().metadata()
        data['schedule_rebuilds'] = self._rebuilds
        return data


def critical_share(summary: dict[str, Any]) -> float | None:
    """Share of priority-3 jobs met on time, or None when none are due yet."""
    due = summary.get('critical_jobs_due', 0)
    if not due:
        return None
    return summary.get('critical_jobs_completed_on_time', 0) / due


__all__ = ['SmartPlanner', 'critical_share', 'CRITICAL_PRIORITY', 'UNREACHABLE_RELAY']
