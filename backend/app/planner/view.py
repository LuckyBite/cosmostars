"""Read-only view over the case environment, handed to planners.

The reference library exposes ``Session.observation()``, but that deep-copies
every job on every call: about 18 seconds per shift on the 8120-job scenario.
Planners therefore read the live environment through this adapter, which never
mutates it and keeps an incremental index of the jobs that are open right now.
"""
from __future__ import annotations

import heapq
from typing import Any, Iterable

Action = dict[str, Any]
Job = dict[str, Any]


class JobIndex:
    """Jobs released and not yet closed, bucketed by eligible satellite.

    Jobs that arrive mid-shift through ``add_jobs`` events are picked up on the
    next refresh, so the index stays correct across events without a rebuild.
    """

    def __init__(self, jobs: dict[str, Job]) -> None:
        self._known: set[str] = set()
        self._pending: list[tuple[int, str]] = []
        self.active: dict[str, Job] = {}
        self.by_satellite: dict[str, set[str]] = {}
        self._absorb(jobs)

    def _absorb(self, jobs: dict[str, Job]) -> None:
        for job_id, job in jobs.items():
            if job_id not in self._known:
                self._known.add(job_id)
                heapq.heappush(self._pending, (job['release_step'], job_id))

    def refresh(self, step: int, jobs: dict[str, Job]) -> None:
        self._absorb(jobs)
        while self._pending and self._pending[0][0] <= step:
            _, job_id = heapq.heappop(self._pending)
            job = jobs.get(job_id)
            if job is None:
                continue
            self.active[job_id] = job
            for sid in job['eligible_satellites']:
                self.by_satellite.setdefault(sid, set()).add(job_id)
        closed = [job_id for job_id, job in self.active.items()
                  if job['completed_step'] is not None or job['deadline_step'] <= step]
        for job_id in closed:
            job = self.active.pop(job_id)
            for sid in job['eligible_satellites']:
                self.by_satellite[sid].discard(job_id)


class StepView:
    """Everything a planner may read at the current step boundary."""

    def __init__(self, env: Any) -> None:
        self._env = env
        self._index = JobIndex(env.jobs)
        self.refresh()

    def refresh(self) -> None:
        self._index.refresh(self._env.k, self._env.jobs)

    # --- shift geometry -------------------------------------------------
    @property
    def step(self) -> int:
        return self._env.k

    @property
    def total_steps(self) -> int:
        return self._env.s['time']['steps']

    @property
    def steps_left(self) -> int:
        return self.total_steps - self._env.k

    @property
    def model(self) -> dict[str, Any]:
        return self._env.s['model']

    @property
    def satellite_ids(self) -> list[str]:
        return sorted(self._env.sats)

    def spec(self, sid: str) -> dict[str, Any]:
        return self._env.sats[sid]

    # --- satellite state ------------------------------------------------
    def state(self, sid: str) -> dict[str, float]:
        return self._env.state[sid]

    def soc_pct(self, sid: str) -> float:
        return 100.0 * self._env.state[sid]['energy_wh'] / self._env.sats[sid]['capacity_wh']

    def calibration_age(self, sid: str) -> int:
        return self._env.state[sid]['calibration_age_steps']

    def calibration_expired(self, sid: str) -> bool:
        return self.calibration_age(sid) >= self.model['calibration_valid_steps']

    def available(self, sid: str) -> bool:
        return self._env.available(sid)

    # --- external conditions --------------------------------------------
    def contact(self, sid: str, kind: str, step: int | None = None) -> bool:
        k = self._env.k if step is None else step
        series = self._env.s['environment'][sid][kind + '_available']
        return bool(series[k]) if 0 <= k < len(series) else False

    def contact_series(self, sid: str, kind: str) -> list[bool]:
        return self._env.s['environment'][sid][kind + '_available']

    def solar_w(self, sid: str, step: int | None = None) -> float:
        k = self._env.k if step is None else step
        return self._env.s['environment'][sid]['solar_w'][k]

    # --- jobs -------------------------------------------------------------
    def open_jobs(self) -> Iterable[Job]:
        return self._index.active.values()

    def jobs_for(self, sid: str) -> list[Job]:
        ids = self._index.by_satellite.get(sid, ())
        return [self._index.active[job_id] for job_id in ids if job_id in self._index.active]

    def job(self, job_id: str) -> Job | None:
        return self._env.jobs.get(job_id)

    def all_jobs(self) -> dict[str, Job]:
        return self._env.jobs

    # --- admissibility ----------------------------------------------------
    def can_execute(self, sid: str, action: Action) -> tuple[bool, str, float]:
        """Library check for one satellite. Shared limits are resolved on step."""
        return self._env.can_execute(sid, action)

    def slack(self, job: Job) -> int:
        """Spare steps between the remaining work and the deadline."""
        return job['deadline_step'] - self._env.k - job['remaining_steps']

    def available_at(self, sid: str, step: int) -> bool:
        """Known availability at a future step, including announced outages."""
        return not any(f['satellite_id'] == sid and f['start_step'] <= step < f['end_step']
                       for f in self._env.s['failures'])

    def downlink_slots(self, job: Job, from_step: int | None = None) -> list[int]:
        """Steps where this downlink job could still be worked, by contact alone."""
        sid = job['eligible_satellites'][0]
        start = max(job['release_step'], self._env.k if from_step is None else from_step)
        series = self._env.s['environment'][sid]['downlink_available']
        return [k for k in range(start, job['deadline_step'])
                if series[k] and self.available_at(sid, k)]
