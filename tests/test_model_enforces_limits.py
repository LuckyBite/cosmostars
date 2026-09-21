"""Модель действительно отклоняет то, что должна.

В таблице результатов у нас стоит `blocked_command_count = 0` на всех четырёх
сценариях. Само по себе это число двусмысленно: его даёт и планировщик, который
проверяет допустимость до отправки, и модель, которая ничего не проверяет.
Разница принципиальная, поэтому здесь мы намеренно нарушаем каждое ограничение
и убеждаемся, что отказ приходит — и приходит с правильной причиной.

Команды подаются прямо в сессию, минуя наш планировщик: смысл теста именно в
том, чтобы обойти собственные проверки и спросить модель.
"""
from __future__ import annotations

import copy

import pytest

from backend.app.core import scenarios
from backend.app.core.run import Run


def reasons(rows: list[dict]) -> dict[str, str]:
    return {row['satellite_id']: row['reason'] for row in rows}


@pytest.fixture()
def shift() -> Run:
    key = 'P02_shift'
    return Run(scenarios.get(key), key, planner_name='cosmostars', goal='priority')


def test_a_job_outside_its_window_is_refused(shift: Run):
    job = next(j for j in shift.session.env.jobs.values() if j['release_step'] > 0)
    sid = job['eligible_satellites'][0]
    rows = shift.session.advance({sid: {'action': 'job', 'job_id': job['id']}})
    assert reasons(rows)[sid] == 'outside_job_window'
    assert shift.session.env.jobs[job['id']]['remaining_steps'] == job['work_steps']


def test_a_satellite_not_on_the_list_is_refused(shift: Run):
    job = next(j for j in shift.session.env.jobs.values()
               if j['release_step'] == 0 and j['kind'] == 'relay')
    outsider = next(sid for sid in sorted(shift.session.env.sats)
                    if sid not in job['eligible_satellites'])
    rows = shift.session.advance({outsider: {'action': 'job', 'job_id': job['id']}})
    assert reasons(rows)[outsider] == 'ineligible_satellite'


def test_a_transmission_without_contact_is_refused(shift: Run):
    env = shift.session.env
    job = next(j for j in env.jobs.values()
               if j['kind'] == 'downlink' and j['release_step'] == 0
               and not env.s['environment'][j['eligible_satellites'][0]]['downlink_available'][0])
    sid = job['eligible_satellites'][0]
    rows = shift.session.advance({sid: {'action': 'job', 'job_id': job['id']}})
    assert reasons(rows)[sid] == 'no_contact'


def test_one_job_cannot_be_served_by_two_satellites_at_once():
    """Одно задание — один исполнитель на шаге.

    Условие собирается, а не ищется в данных: в выданных сценариях нет
    relay-задания, открытого на нулевом шаге, длиной больше одного шага и с
    двумя аппаратами в контакте одновременно. Длина важна — задание на один шаг
    первый исполнитель закрыл бы, и второй получил бы `already_completed`, тоже
    законный отказ, но не тот, который здесь проверяется.
    """
    scenario = copy.deepcopy(scenarios.get('P01_intro'))
    crew = ['S04', 'S08']
    for sid in crew:
        scenario['environment'][sid]['relay_available'][0] = True
    scenario['jobs'].append({
        'id': 'DUP-1', 'kind': 'relay', 'release_step': 0, 'deadline_step': 6,
        'work_steps': 3, 'eligible_satellites': crew, 'priority': 3, 'value_usd': 10.0,
    })
    scenarios.register_upload('dup-check', scenario)

    run = Run(scenario, 'dup-check', planner_name='cosmostars', goal='priority')
    rows = run.session.advance({sid: {'action': 'job', 'job_id': 'DUP-1'} for sid in crew})
    outcome = reasons(rows)
    assert sorted(outcome[sid] for sid in crew) == ['accepted', 'duplicate_job_in_step']
    # Работа списана один раз, а не дважды.
    assert run.session.env.jobs['DUP-1']['remaining_steps'] == 2


def test_the_global_cap_of_two_transmissions_per_step_is_enforced():
    """Третья одновременная передача отклоняется самой моделью.

    В выданных сценариях трёх одновременно обслуживаемых downlink-заданий не
    встречается, поэтому условие собирается: берём короткую смену, открываем
    контакт трём аппаратам на одном шаге и даём каждому по заданию на один шаг.
    Сценарий проходит валидацию выданной библиотеки, то есть остаётся законным.
    """
    scenario = copy.deepcopy(scenarios.get('P01_intro'))
    crew = ['S01', 'S02', 'S03']
    for sid in crew:
        scenario['environment'][sid]['downlink_available'][0] = True
    scenario['jobs'] = [job for job in scenario['jobs'] if job['kind'] != 'downlink']
    for i, sid in enumerate(crew, start=1):
        scenario['jobs'].append({
            'id': f'CAP-{i}', 'kind': 'downlink', 'release_step': 0, 'deadline_step': 4,
            'work_steps': 1, 'eligible_satellites': [sid], 'priority': 3, 'value_usd': 10.0,
        })
    scenarios.register_upload('cap-check', scenario)   # проверяется validate() библиотеки

    run = Run(scenario, 'cap-check', planner_name='cosmostars', goal='priority')
    rows = run.session.advance({sid: {'action': 'job', 'job_id': f'CAP-{i}'}
                                for i, sid in enumerate(crew, start=1)})
    outcome = reasons(rows)
    accepted = [sid for sid in crew if outcome[sid] == 'accepted']
    refused = [sid for sid in crew if outcome[sid] == 'ground_capacity']
    limit = scenario['model']['downlink_parallel_limit']
    assert len(accepted) == limit
    assert len(refused) == len(crew) - limit
    assert run.session.summary()['blocked_command_count'] == len(refused)


def test_our_planner_never_produces_any_of_these(shift: Run):
    """Обратная сторона: при обычной работе ни один из этих отказов не случается."""
    shift.advance_to(shift.total_steps)
    assert shift.session.summary()['blocked_command_count'] == 0
    assert {row['reason'] for row in shift.session.env.trace} <= {'accepted', 'idle'}
