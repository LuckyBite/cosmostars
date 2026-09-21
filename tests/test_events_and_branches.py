"""Continuation after new information: state is kept, history is never redone."""
from __future__ import annotations

import copy
import json

import pytest

from backend.app.core import config, scenarios
from backend.app.core.errors import EventRejected
from backend.app.core.run import Run


def make_run(key: str = 'P02_shift') -> Run:
    return Run(scenarios.get(key), key, planner_name='cosmostars', goal='priority')


def demo_events() -> list[dict]:
    payload = json.loads((config.EXAMPLES_DIR / 'events_demo.json').read_text(encoding='utf-8'))
    return payload['events']


def test_event_keeps_energy_calibration_and_progress():
    run = make_run()
    run.advance_to(72)
    before_state = copy.deepcopy(run.session.env.state)
    before_step = run.step
    run.apply_event(demo_events()[0])
    assert run.step == before_step
    assert run.session.env.state == before_state


def test_rejected_event_leaves_the_shift_untouched():
    run = make_run()
    run.advance_to(72)
    before_state = copy.deepcopy(run.session.env.state)
    before_jobs = len(run.session.env.jobs)
    bad = {'id': 'E-BAD', 'at_step': 200, 'type': 'satellite_outage',
           'satellite_ids': ['S08'], 'end_step': 210}
    with pytest.raises(EventRejected):
        run.apply_event(bad)
    assert run.session.env.state == before_state
    assert len(run.session.env.jobs) == before_jobs
    assert run.session.events == []


def test_the_same_event_cannot_be_applied_twice():
    run = make_run()
    run.advance_to(72)
    event = demo_events()[0]
    run.apply_event(event)
    with pytest.raises(EventRejected):
        run.apply_event(copy.deepcopy(event))


def test_added_jobs_stay_in_the_accounting_even_when_missed():
    run = make_run()
    run.advance_to(72)
    added = demo_events()[0]['jobs']
    before_total = run.session.summary()['jobs_total']
    run.apply_event(demo_events()[0])
    run.advance_to(run.total_steps)
    summary = run.session.summary()
    assert summary['jobs_total'] == before_total + len(added)
    for job in added:
        assert job['id'] in run.session.env.jobs


def test_branches_are_independent():
    parent = make_run()
    parent.advance_to(100)
    left = parent.fork('левая')
    right = parent.fork('правая')
    assert left.id != right.id
    assert left.forked_at_step == right.forked_at_step == 100
    left.set_goal('revenue')
    left.advance(20)
    assert right.step == 100
    assert right.goal == 'priority'
    assert parent.step == 100
    right.advance(20)
    assert left.session.env.state is not right.session.env.state


def test_goal_switch_is_recorded_and_only_affects_later_steps():
    run = make_run()
    run.advance_to(50)
    summary_before = run.session.summary()['jobs_completed']
    run.set_goal('revenue')
    assert run.goal_switches == [{'step': 50, 'goal': 'revenue'}]
    assert run.session.summary()['jobs_completed'] == summary_before
    assert run.result()['run_metadata']['goal_switches'] == [{'step': 50, 'goal': 'revenue'}]


def test_export_replays_to_the_same_numbers():
    from model.operations import replay_episode

    run = make_run('P01_intro')
    run.advance_to(20)
    run.apply_event({'id': 'E-T', 'at_step': 20, 'type': 'satellite_outage',
                     'satellite_ids': ['S01'], 'end_step': 30})
    run.advance_to(run.total_steps)
    exported = run.result()
    replayed = replay_episode(exported['initial_scenario'], exported['events'],
                              exported['commands'], exported['steps_executed'])
    assert replayed.summary() == exported['summary']


def test_parallel_requests_on_one_run_are_serialised():
    """Two tabs, one shift: the second caller waits instead of corrupting the first.

    Without the run lock this interleaves planning and execution, and the planner
    reads a job index another thread is rewriting: an exception, plus commands the
    model refuses — a dozen of them on P02, measured before the lock existed.
    """
    import threading

    run = make_run()
    errors: list[Exception] = []

    def hour() -> None:
        try:
            run.advance(60)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=hour) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    assert run.step == 180
    assert run.summary()['blocked_command_count'] == 0
