"""The views the operator's console is built on, and the claims they make.

Each test here pins a statement the interface makes on screen. If one of them
breaks, a number shown to an expert has become a lie, which is worse than a
crash: these are the assertions that keep the console honest.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def run_to(client: TestClient, step: int, scenario: str = 'P02_shift',
           goal: str = 'priority', planner: str = 'cosmostars') -> str:
    run_id = client.post('/api/runs', json={'scenario_key': scenario, 'goal': goal,
                                            'planner': planner}).json()['run_id']
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': step})
    return run_id


def cumulative(progress: dict[str, list[float]], name: str, upto: int) -> float:
    return sum(progress[name][:upto + 1])


def test_grid_progress_sums_to_the_library_summary(client: TestClient):
    """The tiles move with the cursor; they must still say what the service says.

    The console sums these per-step increments up to the cursor. An independent
    run stopped at the same step is the only fair check of that sum.
    """
    full = run_to(client, 288)
    progress = client.get(f'/api/runs/{full}/grid').json()['progress']
    for step in (60, 144, 288):
        partial = run_to(client, step)
        summary = client.get(f'/api/runs/{partial}').json()['summary']
        assert cumulative(progress, 'completed', step) == summary['jobs_completed']
        assert cumulative(progress, 'due', step) == summary['jobs_due']
        assert cumulative(progress, 'missed', step) == summary['jobs_due_missed']
        assert cumulative(progress, 'critical_due', step) == summary['critical_jobs_due']
        assert (cumulative(progress, 'critical_done', step)
                == summary['critical_jobs_completed_on_time'])
        assert cumulative(progress, 'revenue_usd', step) == pytest.approx(
            summary['revenue_usd'], abs=1e-6)


def test_grid_cells_agree_with_the_execution_log(client: TestClient):
    run_id = run_to(client, 40)
    grid = client.get(f'/api/runs/{run_id}/grid').json()
    rows = client.get(f'/api/runs/{run_id}/trace', params={'limit': 20000}).json()['items']
    jobs = {item['job_id']: item for item in
            client.get(f'/api/runs/{run_id}/jobs', params={'limit': 5000}).json()['items']}
    expected = {'job': ('d', 'r'), 'calibrate': ('c',), 'idle': ('.', 'x')}
    for row in rows:
        cell = grid['actions'][row['satellite_id']][row['step']]
        assert cell in expected[row['executed']]
        if row['executed'] == 'job':
            kind = jobs[row['requested']['job_id']]['kind']
            assert cell == ('d' if kind == 'downlink' else 'r')
    # Beyond the executed frontier the grid says nothing, rather than guessing.
    assert set(grid['actions']['S01'][40:]) == {' '}


def test_verify_reproduces_the_service_own_export(client: TestClient):
    run_id = run_to(client, 120)
    client.post(f'/api/runs/{run_id}/events/close-downlink',
                json={'satellite_ids': ['S09', 'S10'], 'end_step': 200})
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': 160})
    report = client.post(f'/api/runs/{run_id}/verify').json()
    assert report['verdict'] == 'reproduced'
    assert report['scenario']['match'] and report['summary']['match'] and report['trace']['match']
    assert report['trace']['rows_replayed'] == 160 * 48
    assert report['replay']['events_replayed'] == 1
    assert report['checked_by'] == 'model.operations.replay_episode'

    # The same export, handed over as a file, gets the same answer.
    export = client.get(f'/api/runs/{run_id}/result').json()
    assert client.post('/api/verify', json={'result': export}).json()['verdict'] == 'reproduced'


def test_verify_refuses_a_damaged_export_without_pretending(client: TestClient):
    export = client.get(f'/api/runs/{run_to(client, 20, "P01_intro")}/result').json()
    export['summary']['revenue_usd'] += 1000
    report = client.post('/api/verify', json={'result': export}).json()
    assert report['verdict'] == 'diverged'
    assert any(item['field'] == 'revenue_usd' for item in report['summary']['mismatches'])

    assert client.post('/api/verify', json={'result': {'schema_version': 'nope'}}).status_code == 400


def test_every_missed_downlink_job_on_p02_carries_a_certificate(client: TestClient):
    """The claim the explain panel makes for P02: nothing was lost to the planner."""
    run_id = run_to(client, 288)
    missed = client.get(f'/api/runs/{run_id}/jobs',
                        params={'status': 'missed', 'limit': 5000}).json()['items']
    downlink = [item for item in missed if item['kind'] == 'downlink']
    assert len(downlink) == 44
    for item in downlink:
        report = client.get(f'/api/runs/{run_id}/jobs/{item["job_id"]}/explain').json()
        assert report['verdict'] == 'impossible_by_data'
        assert report['impossible']['contacts_in_window'] < report['impossible']['work_required']


def test_explain_reads_a_refusal_out_of_the_log_not_out_of_opinion(client: TestClient):
    """On the energy scenario the baseline does get refused; we report why."""
    run_id = run_to(client, 288, scenario='P03_energy', planner='baseline-edf')
    missed = client.get(f'/api/runs/{run_id}/jobs',
                        params={'status': 'missed', 'limit': 5000}).json()['items']
    reasons = set()
    for item in missed[:60]:
        report = client.get(f'/api/runs/{run_id}/jobs/{item["job_id"]}/explain').json()
        if report['refusals']['total']:
            reasons.add(report['refusals']['dominant_reason'])
            assert report['verdict'] in ('refused_by_satellite', 'impossible_by_data')
        # No schedule exists for this planner, so no contest layer is invented.
        assert report['competition'] is None
    assert reasons <= {'energy_reserve', 'thermal_limit', 'calibration_required',
                       'no_contact', 'ground_capacity', 'duplicate_job_in_step',
                       'satellite_unavailable', 'outside_job_window'}


def test_slot_prices_name_the_ground_of_every_price(client: TestClient):
    run_id = run_to(client, 1)
    prices = client.get(f'/api/runs/{run_id}/slot-prices').json()['prices']
    assert prices['totals']['contact_slots'] == len(prices['rows'])
    for row in prices['rows']:
        assert (row['price_usd'] > 0) == (row['price_job_id'] is not None)
        # A price without a stated ground would read as an accusation of the
        # planner even when the scenario is at fault.
        assert (row['price_ground'] is not None) == (row['price_usd'] > 0)
        assert row['price_ground'] in (None, 'unreachable_by_window', 'lost_to_selection')
    assert prices['totals']['slots_assigned'] + prices['totals']['slots_unused'] \
        == prices['totals']['contact_slots']


def test_contacts_and_events_feed_the_timeline(client: TestClient):
    run_id = run_to(client, 72)
    client.post(f'/api/runs/{run_id}/events/outage',
                json={'satellite_ids': ['S05'], 'end_step': 100})
    contacts = client.get(f'/api/runs/{run_id}/contacts').json()
    assert contacts['total_steps'] == 288 and len(contacts['items']) == 48
    assert {'satellite_id': 'S05', 'start_step': 72, 'end_step': 100} in contacts['outages']
    for item in contacts['items']:
        for interval in item['downlink'] + item['relay']:
            assert 0 <= interval[0] < interval[1] <= 288
    events = client.get(f'/api/runs/{run_id}/events').json()['items']
    assert len(events) == 1 and events[0]['at_step'] == 72
    assert events[0]['type'] == 'satellite_outage'


def test_the_shift_ceiling_survives_the_end_of_the_shift(client: TestClient):
    """At the last step nothing is ahead, so the live ceiling is zero by design.

    The console divides by the opening snapshot instead, which is why the report
    carries both.
    """
    run_id = run_to(client, 288)
    report = client.get(f'/api/runs/{run_id}/feasibility').json()
    assert report['downlink_ceiling']['work_steps_demanded'] == 0
    opening = report['at_open']['downlink_ceiling']
    assert opening['work_steps_demanded'] == 410
    assert opening['jobs_unreachable_by_window'] == 44
    assert report['at_open']['totals']['impossible_critical_count'] == 19
