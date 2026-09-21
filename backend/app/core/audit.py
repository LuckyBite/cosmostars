"""Пересчёт журнала смены независимой реализацией.

Проверка воспроизводимости в `verify.py` отвечает на вопрос «повторяется ли
расчёт»: она отдаёт выгрузку той же библиотеке и сверяет результат. Это важно,
но у такой проверки есть предел — библиотека сверяется сама с собой.

Здесь другое. Каждая строка журнала пересчитывается по формулам из описания
модели, не обращаясь к библиотеке: сколько ватт потребляла команда, сколько
энергии ушло и пришло, куда сместилась температура, сколько работы сделано по
каждому заданию, какие задания завершены, какая из этого выручка. Если две
независимые реализации сходятся на всех 13 824 строках, то утверждение «учёт
корректен» опирается не на доверие к одной из них.

Что именно пересчитывается:

* **мощность** — по исполненной команде: простой ноль, калибровка
  `calibration_w`, задание `downlink_w` или `relay_w` по его типу;
* **обогрев** — включается, когда температура до шага ниже `heater_below_c`;
* **энергия** — `(solar − load) · dt/3600` с КПД заряда, если прибыток, и КПД
  разряда, если убыток; заряд вне температурного окна не идёт вообще;
* **температура** — экспоненциальная релаксация к равновесию
  `thermal_target + gain · load` с постоянной `thermal_tau_s`;
* **учёт** — прогресс по заданиям из самих строк, завершение по набранной
  работе, выручка по завершённым, обязательства по наступившим срокам.

Расхождения возвращаются списком, а не прячутся в булев флаг: если учёт где-то
не сходится, оператор должен увидеть, где именно.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .run import Run

TOLERANCE_WH = 1e-6
TOLERANCE_C = 1e-6
MAX_MISMATCHES = 20


def _payload_watts(spec: dict[str, Any], row: dict[str, Any],
                   kinds: dict[str, str]) -> float:
    """Мощность полезной нагрузки, которую требовала исполненная команда."""
    executed = row['executed']
    if executed == 'calibrate':
        return float(spec['calibration_w'])
    if executed == 'job':
        job_id = (row.get('requested') or {}).get('job_id')
        kind = kinds.get(job_id) if isinstance(job_id, str) else None
        if kind is None:
            # Исполненное задание без известного типа — само по себе расхождение;
            # nan гарантированно не совпадёт ни с чем и попадёт в отчёт.
            return float('nan')
        return float(spec[kind + '_w'])
    return 0.0


def _physics(run: Run) -> dict[str, Any]:
    """Сверка энергии и температуры построчно."""
    env = run.session.env
    model = env.s['model']
    step_seconds = env.s['time']['step_s']
    kinds = {job_id: job['kind'] for job_id, job in env.jobs.items()}
    mismatches: list[dict[str, Any]] = []

    for row in env.trace:
        sid = row['satellite_id']
        spec = env.sats[sid]
        payload = _payload_watts(spec, row, kinds)
        heater = float(spec['heater_w']) if row['temp_before_c'] < model['heater_below_c'] else 0.0
        load = float(spec['base_w']) + heater + payload

        delta = (row['solar_w'] - load) * step_seconds / 3600
        if delta >= 0:
            in_window = model['charge_min_c'] <= row['temp_before_c'] <= model['charge_max_c']
            delta = delta * model['charge_efficiency'] if in_window else 0.0
        else:
            delta /= model['discharge_efficiency']
        energy = min(float(spec['capacity_wh']), max(0.0, row['energy_before_wh'] + delta))

        equilibrium = env.s['environment'][sid]['thermal_target_c'][row['step']] \
            + model['thermal_gain_c_per_w'] * load
        temp = equilibrium + (row['temp_before_c'] - equilibrium) \
            * math.exp(-step_seconds / model['thermal_tau_s'])

        for field, ours, theirs, tolerance in (
            ('heater_w', heater, row['heater_w'], TOLERANCE_WH),
            ('load_w', load, row['load_w'], TOLERANCE_WH),
            ('energy_after_wh', energy, row['energy_after_wh'], 1e-5),
            ('temp_after_c', temp, row['temp_after_c'], 1e-5),
        ):
            if not math.isclose(ours, theirs, abs_tol=tolerance, rel_tol=1e-9):
                mismatches.append({'step': row['step'], 'satellite_id': sid, 'field': field,
                                   'recomputed': round(ours, 9), 'in_log': theirs})

    return {'rows_checked': len(env.trace), 'match': not mismatches,
            'mismatches': mismatches[:MAX_MISMATCHES], 'mismatch_count': len(mismatches)}


def _accounting(run: Run) -> dict[str, Any]:
    """Прогресс, завершение и выручка, собранные из журнала с нуля."""
    env = run.session.env
    step = env.k
    done: dict[str, int] = {}
    completed_at: dict[str, int] = {}
    blocked = 0

    for row in env.trace:
        if row['reason'] not in ('accepted', 'idle'):
            blocked += 1
        if row['executed'] != 'job':
            continue
        job_id = (row.get('requested') or {}).get('job_id')
        if job_id is None:
            continue
        done[job_id] = done.get(job_id, 0) + 1
        job = env.jobs.get(job_id)
        if job is not None and job_id not in completed_at and done[job_id] >= job['work_steps']:
            completed_at[job_id] = row['step'] + 1

    revenue = 0.0
    critical_due = critical_done = due = missed = 0
    for job_id, job in env.jobs.items():
        if job_id in completed_at:
            revenue += job['value_usd']
        if job['deadline_step'] <= step:
            due += 1
            if job_id not in completed_at:
                missed += 1
            if job['priority'] == 3:
                critical_due += 1
                critical_done += int(job_id in completed_at)

    ours = {
        'jobs_completed': len(completed_at),
        'revenue_usd': round(revenue, 6),
        'jobs_due': due,
        'jobs_due_missed': missed,
        'critical_jobs_due': critical_due,
        'critical_jobs_completed_on_time': critical_done,
        'blocked_command_count': blocked,
    }
    theirs = run.session.summary()
    mismatches = [{'field': field, 'recomputed': value, 'in_summary': theirs.get(field)}
                  for field, value in ours.items()
                  if not math.isclose(float(value), float(theirs.get(field, 0)),
                                      abs_tol=1e-6, rel_tol=1e-9)]
    # Завершение задания фиксируется библиотекой в completed_step — сверяем и его,
    # иначе совпадение количеств могло бы скрывать расхождение по шагам.
    step_mismatches = [{'job_id': job_id, 'recomputed': at,
                        'in_state': env.jobs[job_id]['completed_step']}
                       for job_id, at in completed_at.items()
                       if env.jobs[job_id]['completed_step'] != at]
    return {'recomputed': ours, 'match': not mismatches and not step_mismatches,
            'mismatches': mismatches,
            'completion_step_mismatches': step_mismatches[:MAX_MISMATCHES],
            'completion_step_mismatch_count': len(step_mismatches)}


def audit(run: Run) -> dict[str, Any]:
    """Полный независимый пересчёт исполненной истории смены."""
    physics = _physics(run)
    accounting = _accounting(run)
    return {
        'at_step': run.step,
        'verdict': 'consistent' if physics['match'] and accounting['match'] else 'inconsistent',
        'physics': physics,
        'accounting': accounting,
        'checked_by': 'backend.app.core.audit (независимо от model/)',
        'what_it_proves': ('Энергия, температура, прогресс, завершение и выручка пересчитаны '
                           'по описанию модели без обращения к выданной библиотеке и совпали '
                           'с журналом и сводкой.'),
    }
