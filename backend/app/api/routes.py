"""HTTP surface for the operator.

The shape follows the operator's path through a shift: pick a scenario, start a
run, advance it, feed a message, branch, compare, export. Every endpoint reads
or drives one run; nothing here holds planner logic.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Query

from ..core import compare as compare_mod
from ..core import scenarios
from ..core import verify as verify_mod
from ..core.errors import BadRequest
from ..core.registry import registry
from ..planner import GOALS, PLANNERS
from .schemas import (
    AdvanceRequest,
    CloseDownlinkRequest,
    CreateRun,
    EventRequest,
    ForkRequest,
    GoalRequest,
    OutageRequest,
    UploadScenario,
    VerifyRequest,
)

router = APIRouter(prefix='/api')


@router.get('/health')
def health() -> dict[str, Any]:
    return {'status': 'ok', **registry.capacity()}


@router.get('/planners')
def planners() -> dict[str, Any]:
    return {
        'goals': list(GOALS),
        'planners': [{'name': name, 'version': cls.version} for name, cls in PLANNERS.items()],
    }


@router.get('/scenarios')
def list_scenarios() -> dict[str, Any]:
    return {'items': scenarios.catalogue()}


@router.post('/scenarios')
def upload_scenario(body: UploadScenario) -> dict[str, Any]:
    return scenarios.register_upload(body.key, body.scenario)


@router.get('/runs')
def list_runs() -> dict[str, Any]:
    return {'items': registry.list()}


@router.post('/runs', status_code=201)
def create_run(body: CreateRun) -> dict[str, Any]:
    run = registry.create(body.scenario_key, body.planner, body.goal,
                          title=body.title, parameters=body.parameters)
    return run.info()


@router.get('/runs/{run_id}')
def get_run(run_id: str) -> dict[str, Any]:
    return registry.get(run_id).info()


@router.delete('/runs/{run_id}', status_code=204)
def delete_run(run_id: str) -> None:
    registry.delete(run_id)


@router.post('/runs/{run_id}/advance')
def advance(run_id: str, body: AdvanceRequest) -> dict[str, Any]:
    run = registry.get(run_id)
    # Ровно одно из двух: либо «выполнить N шагов», либо «остановиться перед
    # шагом N». Развилка написана явно, а не через отрицание: так видно, что
    # ни одна ветвь не работает с None.
    if body.steps is not None and body.to_step is None:
        executed = run.advance(body.steps)
    elif body.to_step is not None and body.steps is None:
        executed = run.advance_to(body.to_step)
    else:
        raise BadRequest('Provide exactly one of steps or to_step')
    return {'executed_steps': executed, **run.info()}


@router.post('/runs/{run_id}/events')
def post_event(run_id: str, body: EventRequest) -> dict[str, Any]:
    run = registry.get(run_id)
    applied = run.apply_event(body.event)
    return {'accepted': applied, **run.info()}


def _interval_event(run_id: str, kind: str, body: OutageRequest) -> dict[str, Any]:
    run = registry.get(run_id)
    event = {
        'id': body.event_id or f'UI-{kind}-{uuid.uuid4().hex[:8]}',
        'at_step': run.step,
        'type': kind,
        'satellite_ids': list(body.satellite_ids),
        'end_step': body.end_step,
    }
    applied = run.apply_event(event)
    return {'accepted': applied, **run.info()}


@router.post('/runs/{run_id}/events/outage')
def post_outage(run_id: str, body: OutageRequest) -> dict[str, Any]:
    return _interval_event(run_id, 'satellite_outage', body)


@router.post('/runs/{run_id}/events/close-downlink')
def post_close_downlink(run_id: str, body: CloseDownlinkRequest) -> dict[str, Any]:
    return _interval_event(run_id, 'close_downlink', body)


@router.post('/runs/{run_id}/goal')
def set_goal(run_id: str, body: GoalRequest) -> dict[str, Any]:
    run = registry.get(run_id)
    run.set_goal(body.goal)
    return run.info()


@router.post('/runs/{run_id}/fork', status_code=201)
def fork_run(run_id: str, body: ForkRequest) -> dict[str, Any]:
    return registry.fork(run_id, body.title).info()


@router.get('/runs/{run_id}/events')
def run_events(run_id: str) -> dict[str, Any]:
    return {'items': registry.get(run_id).events()}


@router.get('/runs/{run_id}/contacts')
def run_contacts(run_id: str) -> dict[str, Any]:
    return registry.get(run_id).contacts()


@router.get('/runs/{run_id}/satellites')
def satellites(run_id: str) -> dict[str, Any]:
    return {'items': registry.get(run_id).satellites()}


@router.get('/runs/{run_id}/jobs')
def jobs(run_id: str,
         status: str = Query(default='all', pattern='^(all|open|pending|completed|missed)$'),
         limit: int = Query(default=200, ge=1, le=5000),
         offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    return registry.get(run_id).jobs(status=status, limit=limit, offset=offset)


@router.get('/runs/{run_id}/trace')
def trace(run_id: str, from_step: int | None = None, to_step: int | None = None,
          satellite_id: str | None = None,
          limit: int = Query(default=2000, ge=1, le=20000)) -> dict[str, Any]:
    return registry.get(run_id).trace(from_step, to_step, satellite_id, limit)


@router.get('/runs/{run_id}/series/{satellite_id}')
def series(run_id: str, satellite_id: str) -> dict[str, Any]:
    return registry.get(run_id).series(satellite_id)


@router.get('/runs/{run_id}/feasibility')
def feasibility(run_id: str) -> dict[str, Any]:
    return registry.get(run_id).feasibility()


@router.get('/runs/{run_id}/grid')
def run_grid(run_id: str) -> dict[str, Any]:
    return registry.get(run_id).grid()


@router.get('/runs/{run_id}/jobs/{job_id}/explain')
def explain_job(run_id: str, job_id: str) -> dict[str, Any]:
    return registry.get(run_id).explain_job(job_id)


@router.get('/runs/{run_id}/slot-prices')
def slot_prices(run_id: str) -> dict[str, Any]:
    return {'prices': registry.get(run_id).slot_prices()}


@router.get('/runs/{run_id}/downlink-plan')
def downlink_plan(run_id: str) -> dict[str, Any]:
    plan = registry.get(run_id).downlink_plan()
    return {'plan': plan}


@router.get('/runs/{run_id}/result')
def result(run_id: str) -> dict[str, Any]:
    return registry.get(run_id).result()


@router.post('/runs/{run_id}/verify')
def verify_run(run_id: str) -> dict[str, Any]:
    """Replay this run's own export: the one-click form of the check below."""
    return verify_mod.verify(registry.get(run_id).result())


@router.post('/verify')
def verify_export(body: VerifyRequest) -> dict[str, Any]:
    """Replay an uploaded export through the reference library."""
    return verify_mod.verify(body.result)


@router.get('/compare')
def compare(left: str, right: str, goal: str | None = None) -> dict[str, Any]:
    left_run, right_run = registry.pair(left, right)
    return compare_mod.compare(left_run, right_run, goal)
