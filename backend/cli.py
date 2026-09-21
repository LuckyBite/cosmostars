"""Batch experiments without the browser.

The experiment track needs numbers long before the interface is finished, and
the jury needs the numbers to be reproducible. Every run here takes the same
path through the same planner as the web service, and writes an export that
replays with the reference library:

    python -m backend.cli run --scenario P02_shift --goal priority
    python -m backend.cli sweep --scenarios P01_intro P02_shift P03_energy
    python -m backend.cli feasibility --scenario P02_shift
    python -m backend.cli ceiling --scenarios P01_intro P02_shift P03_energy P04_demand
    python -m backend.cli tune --param calibration_lead --values 0 3 6 12 24
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .app.core import config, scenarios
from .app.core.run import Run
from .app.planner import DEFAULT_PLANNER, GOALS, PLANNERS

REPORT_KEYS = ('jobs_completed', 'critical_jobs_completed_on_time', 'critical_jobs_due',
               'revenue_usd', 'jobs_due_missed', 'work_steps_in_missed_jobs',
               'blocked_command_count', 'below_reserve_satellite_steps', 'minimum_soc_pct')


def _load_events(path: str | None) -> list[dict[str, Any]]:
    if not path:
        return []
    payload = json.loads(Path(path).read_text(encoding='utf-8'))
    events = payload.get('events') if isinstance(payload, dict) else payload
    if not isinstance(events, list):
        raise SystemExit(f'{path}: expected a list of events')
    return sorted(events, key=lambda e: e['at_step'])


def execute(scenario_key: str, planner: str, goal: str,
            events: list[dict[str, Any]], stop_at: int | None = None,
            parameters: dict[str, Any] | None = None) -> Run:
    """Play one shift to the end, delivering each event exactly at its step."""
    run = Run(scenarios.get(scenario_key), scenario_key, planner_name=planner, goal=goal,
              parameters=parameters)
    for event in events:
        at_step = event['at_step']
        if stop_at is not None and at_step > stop_at:
            break
        run.advance_to(at_step)
        run.apply_event(event)
    run.advance_to(run.total_steps if stop_at is None else min(stop_at, run.total_steps))
    return run


def _export(run: Run, out: Path | None) -> Path | None:
    if out is None:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(run.result(), ensure_ascii=False, indent=2, allow_nan=False),
                   encoding='utf-8')
    return out


def cmd_run(args: argparse.Namespace) -> int:
    run = execute(args.scenario, args.planner, args.goal, _load_events(args.events), args.stop_at)
    summary = run.session.summary()
    print(json.dumps({'run': run.info()['title'], 'planner': args.planner, 'goal': args.goal,
                      'summary': {k: summary[k] for k in REPORT_KEYS}},
                     ensure_ascii=False, indent=2))
    path = _export(run, Path(args.out) if args.out else None)
    if path:
        print(f'\nВыгрузка: {path}')
        print(f'Проверка: python model/operations.py --result {path} --output replay.json')
    return 0


def cmd_sweep(args: argparse.Namespace) -> int:
    events = _load_events(args.events)
    rows = []
    for scenario_key in args.scenarios:
        for planner in args.planners:
            for goal in args.goals:
                run = execute(scenario_key, planner, goal, events)
                summary = run.session.summary()
                rows.append({'scenario': scenario_key, 'planner': planner, 'goal': goal,
                             **{k: summary[k] for k in REPORT_KEYS}})
                if args.export_dir:
                    _export(run, Path(args.export_dir) / f'{scenario_key}-{planner}-{goal}.json')
    header = ['scenario', 'planner', 'goal', *REPORT_KEYS]
    widths = [max(len(h), *(len(f'{row[h]:g}' if isinstance(row[h], float) else str(row[h]))
                            for row in rows)) for h in header]
    print('  '.join(h.ljust(w) for h, w in zip(header, widths)))
    for row in rows:
        cells = [f'{row[h]:g}' if isinstance(row[h], float) else str(row[h]) for h in header]
        print('  '.join(c.ljust(w) for c, w in zip(cells, widths)))
    if args.csv:
        path = Path(args.csv)
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [','.join(header)]
        lines += [','.join(str(row[h]) for h in header) for row in rows]
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        print(f'\nCSV: {path}')
    return 0


def cmd_feasibility(args: argparse.Namespace) -> int:
    run = Run(scenarios.get(args.scenario), args.scenario, planner_name=DEFAULT_PLANNER,
              goal='priority')
    report = run.feasibility()
    print(json.dumps(report['totals'] | {'downlink_ceiling': report['downlink_ceiling']},
                     ensure_ascii=False, indent=2))
    for item in report['impossible_jobs'][:args.show]:
        print(f"  {item['job_id']} · {item['satellite_id']} · приоритет {item['priority']} · "
              f"${item['value_usd']} — контактов {item['contacts_in_window']} "
              f"при работе {item['work_required']} в окне {item['window']}")
    for item in report['oversubscribed_satellites'][:args.show]:
        print(f"  {item['satellite_id']} · шаги {item['interval']} — "
              f"работа {item['work_required']} при {item['contacts_in_interval']} контактах, "
              f"недостача {item['shortfall']}")
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'\nОтчёт: {path}')
    return 0


def cmd_ceiling(args: argparse.Namespace) -> int:
    """How far the committed downlink plan sits from the relaxed flow optimum.

    The selection order is provably optimal for single-step jobs and only a
    lower bound for multi-step ones, so the honest thing is to measure the gap
    rather than describe it. The optimum here ignores the all-or-nothing payment
    rule, so no planner can beat it.
    """
    from .app.planner import downlink

    rows = []
    for scenario_key in args.scenarios:
        run = Run(scenarios.get(scenario_key), scenario_key,
                  planner_name=DEFAULT_PLANNER, goal=args.goal)
        optimum = downlink.ceiling(run.view)['work_steps_schedulable']
        schedule = downlink.build_schedule(run.view, args.goal)
        committed = sum(len(byS) for byS in schedule.by_step.values())
        run.advance_to(run.total_steps)
        served = sum(row.count('d') for row in run.grid()['actions'].values())
        rows.append({'scenario': scenario_key, 'flow_optimum': optimum,
                     'committed': committed, 'executed': served,
                     'gap': optimum - served})
    header = ['scenario', 'flow_optimum', 'committed', 'executed', 'gap']
    widths = [max(len(h), *(len(str(row[h])) for row in rows)) for h in header]
    print('  '.join(h.ljust(w) for h, w in zip(header, widths)))
    for row in rows:
        print('  '.join(str(row[h]).ljust(w) for h, w in zip(header, widths)))
    worst = max(row['gap'] for row in rows)
    print()
    print(f'Наибольший разрыв до оптимума потока: {worst} шагов работы.')
    if worst == 0:
        print('На этих сценариях порядок отбора достигает оптимума, а не приближает его.')
    return 0


def cmd_tune(args: argparse.Namespace) -> int:
    """Чувствительность результата к настройкам планировщика.

    Критерий требует зафиксированных настроек, но зафиксировать их мало —
    надо показать, что результат от них зависит понятным образом и что
    значение по умолчанию выбрано не наугад.
    """
    values: list[Any] = []
    for raw in args.values:
        values.append(float(raw) if '.' in raw else int(raw))
    rows = []
    for scenario_key in args.scenarios:
        for value in values:
            run = execute(scenario_key, DEFAULT_PLANNER, args.goal, _load_events(args.events),
                          parameters={args.param: value})
            summary = run.session.summary()
            rows.append({'scenario': scenario_key, args.param: value,
                         **{k: summary[k] for k in REPORT_KEYS}})
    header = ['scenario', args.param, *REPORT_KEYS]
    widths = [max(len(h), *(len(f'{row[h]:g}' if isinstance(row[h], float) else str(row[h]))
                            for row in rows)) for h in header]
    print('  '.join(h.ljust(w) for h, w in zip(header, widths)))
    for row in rows:
        cells = [f'{row[h]:g}' if isinstance(row[h], float) else str(row[h]) for h in header]
        print('  '.join(c.ljust(w) for c, w in zip(cells, widths)))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='backend.cli', description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    one = sub.add_parser('run', help='Одна смена от начала до конца')
    one.add_argument('--scenario', required=True)
    one.add_argument('--planner', default=DEFAULT_PLANNER, choices=sorted(PLANNERS))
    one.add_argument('--goal', default='priority', choices=list(GOALS))
    one.add_argument('--events', help='JSON-файл сообщений')
    one.add_argument('--stop-at', type=int, dest='stop_at')
    one.add_argument('--out', help='Куда сохранить выгрузку результата')
    one.set_defaults(func=cmd_run)

    many = sub.add_parser('sweep', help='Матрица сценариев, планировщиков и целей')
    many.add_argument('--scenarios', nargs='+', default=['P01_intro', 'P02_shift', 'P03_energy'])
    many.add_argument('--planners', nargs='+', default=sorted(PLANNERS))
    many.add_argument('--goals', nargs='+', default=list(GOALS))
    many.add_argument('--events', help='Одинаковые сообщения для всех прогонов')
    many.add_argument('--csv')
    many.add_argument('--export-dir', dest='export_dir')
    many.set_defaults(func=cmd_sweep)

    proof = sub.add_parser('feasibility', help='Что в сценарии невыполнимо и почему')
    proof.add_argument('--scenario', required=True)
    proof.add_argument('--show', type=int, default=10)
    proof.add_argument('--out')
    proof.set_defaults(func=cmd_feasibility)

    top = sub.add_parser('ceiling', help='Разрыв между расписанием связи и оптимумом потока')
    top.add_argument('--scenarios', nargs='+',
                     default=['P01_intro', 'P02_shift', 'P03_energy', 'P04_demand'])
    top.add_argument('--goal', default='priority', choices=list(GOALS))
    top.set_defaults(func=cmd_ceiling)

    knob = sub.add_parser('tune', help='Чувствительность к настройкам планировщика')
    knob.add_argument('--param', default='calibration_lead',
                      choices=['calibration_lead', 'relay_soc_floor_pct'])
    knob.add_argument('--values', nargs='+', required=True)
    knob.add_argument('--scenarios', nargs='+', default=['P03_energy', 'P04_demand'])
    knob.add_argument('--goal', default='priority', choices=list(GOALS))
    knob.add_argument('--events')
    knob.set_defaults(func=cmd_tune)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
