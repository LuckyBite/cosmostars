"""The operator's path through the service, end to end over HTTP."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def start_run(client: TestClient, scenario: str = 'P01_intro', goal: str = 'priority') -> str:
    response = client.post('/api/runs', json={'scenario_key': scenario, 'goal': goal})
    assert response.status_code == 201, response.text
    return response.json()['run_id']


def test_catalogue_lists_the_bundled_scenarios(client: TestClient):
    items = client.get('/api/scenarios').json()['items']
    keys = {item['key'] for item in items}
    assert {'P01_intro', 'P02_shift', 'P03_energy', 'P04_demand'} <= keys
    intro = next(item for item in items if item['key'] == 'P01_intro')
    assert intro['satellites'] == 16 and intro['steps'] == 48


def test_operator_can_run_pause_and_read_the_shift(client: TestClient):
    run_id = start_run(client)
    advanced = client.post(f'/api/runs/{run_id}/advance', json={'to_step': 10}).json()
    assert advanced['step'] == 10 and advanced['executed_steps'] == 10
    satellites = client.get(f'/api/runs/{run_id}/satellites').json()['items']
    assert len(satellites) == 16 and all('soc_pct' in sat for sat in satellites)
    series = client.get(f'/api/runs/{run_id}/series/S01').json()
    assert len(series['points']) == 10
    trace = client.get(f'/api/runs/{run_id}/trace').json()
    assert trace['total'] == 10 * 16


def test_unknown_run_answers_with_an_explanation(client: TestClient):
    response = client.get('/api/runs/does-not-exist')
    assert response.status_code == 404
    assert 'message' in response.json()


def test_malformed_event_is_refused_without_breaking_the_run(client: TestClient):
    run_id = start_run(client)
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': 10})
    bad = {'id': 'E-1', 'at_step': 30, 'type': 'satellite_outage',
           'satellite_ids': ['S01'], 'end_step': 40}
    response = client.post(f'/api/runs/{run_id}/events', json={'event': bad})
    assert response.status_code == 409
    assert client.get(f'/api/runs/{run_id}').json()['step'] == 10


def test_manual_outage_entry_uses_the_current_step(client: TestClient):
    run_id = start_run(client)
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': 10})
    response = client.post(f'/api/runs/{run_id}/events/outage',
                           json={'satellite_ids': ['S01', 'S02'], 'end_step': 20})
    assert response.status_code == 200, response.text
    accepted = response.json()['accepted']
    assert accepted['at_step'] == 10 and accepted['type'] == 'satellite_outage'
    assert response.json()['events_received'] == 1


def test_branches_compare_from_one_control_state(client: TestClient):
    run_id = start_run(client)
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': 12})
    left = client.post(f'/api/runs/{run_id}/fork', json={'title': 'приоритет'}).json()['run_id']
    right = client.post(f'/api/runs/{run_id}/fork', json={'title': 'выручка'}).json()['run_id']
    client.post(f'/api/runs/{right}/goal', json={'goal': 'revenue'})
    for branch in (left, right):
        client.post(f'/api/runs/{branch}/advance', json={'to_step': 48})
    comparison = client.get('/api/compare', params={'left': left, 'right': right}).json()
    assert comparison['comparability']['shared_origin']['parent_run_id'] == run_id
    assert comparison['comparability']['comparable'] is True
    assert comparison['verdict']['text']
    assert any(row['metric'] == 'revenue_usd' for row in comparison['metrics'])


def test_result_export_carries_metadata_and_replays(client: TestClient):
    from model.operations import replay_episode

    run_id = start_run(client, 'P01_intro', 'revenue')
    client.post(f'/api/runs/{run_id}/advance', json={'to_step': 48})
    exported = client.get(f'/api/runs/{run_id}/result').json()
    assert exported['schema_version'] == 'cosmo-B-ops-result-1.0'
    assert exported['run_metadata']['goal'] == 'revenue'
    assert exported['run_metadata']['algorithm'] == 'cosmostars'
    replayed = replay_episode(exported['initial_scenario'], exported['events'],
                              exported['commands'], exported['steps_executed'])
    assert replayed.summary() == exported['summary']


def test_feasibility_report_is_available_to_the_operator(client: TestClient):
    run_id = start_run(client, 'P02_shift')
    report = client.get(f'/api/runs/{run_id}/feasibility').json()
    assert report['totals']['impossible_job_count'] == 44
    assert report['impossible_jobs'][0]['certificate'] == 'contact_window_shorter_than_work'
