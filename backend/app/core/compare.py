"""Side-by-side reading of two continuations.

The statement requires comparisons to be honest about their own validity: the
branches must start from the same control state and receive the same messages.
Rather than silently assuming that, the comparison states what it checked, and
says plainly when two results are equivalent instead of inventing a winner.
"""
from __future__ import annotations

from typing import Any

from .run import Run

# Below these, a difference is reported as equivalent rather than as a win.
CRITICAL_TIE = 0
REVENUE_TIE_USD = 1e-06

METRICS = (
    ('critical_jobs_completed_on_time', 'больше', 'заданий приоритета 3 в срок'),
    ('critical_jobs_due', 'нейтрально', 'заданий приоритета 3 с наступившим сроком'),
    ('revenue_usd', 'больше', 'выручка, $'),
    ('jobs_completed', 'больше', 'завершено заданий'),
    ('jobs_due_missed', 'меньше', 'просрочено заданий'),
    ('work_steps_in_missed_jobs', 'меньше', 'работа, потраченная впустую'),
    ('blocked_command_count', 'меньше', 'отклонённых команд'),
    ('below_reserve_satellite_steps', 'меньше', 'аппарато-шагов ниже резерва'),
    ('critical_soc_satellite_steps', 'меньше', 'аппарато-шагов ниже критического порога'),
    ('brownout_satellite_steps', 'меньше', 'эпизодов нехватки питания'),
    ('minimum_soc_pct', 'больше', 'минимальный заряд, %'),
    ('steps_executed', 'нейтрально', 'выполнено шагов'),
)


def _event_ids(run: Run) -> list[str]:
    return [event['id'] for event in run.session.events]


def _comparability(left: Run, right: Run) -> dict[str, Any]:
    """What makes this pair readable, and what would make it misleading."""
    warnings = []
    if left.scenario_id != right.scenario_id:
        warnings.append('Ветви построены на разных сценариях — сравнение некорректно')
    if left.step != right.step:
        warnings.append(f'Разное число выполненных шагов: {left.step} и {right.step}')
    if _event_ids(left) != _event_ids(right):
        warnings.append('Ветви получили разные сообщения или в разном порядке')
    shared = None
    for run, other in ((left, right), (right, left)):
        if run.parent_id == other.id:
            shared = {'parent_run_id': other.id, 'branch_step': run.forked_at_step}
    if shared is None and left.parent_id and left.parent_id == right.parent_id:
        same_step = left.forked_at_step == right.forked_at_step
        shared = {'parent_run_id': left.parent_id,
                  'branch_step': left.forked_at_step if same_step else None}
    if shared is None:
        warnings.append('Ветви не имеют общего контрольного состояния — '
                        'это два независимых запуска')
    return {'shared_origin': shared, 'warnings': warnings,
            'comparable': not warnings}


def _verdict(goal: str, left: Run, right: Run,
             left_summary: dict[str, Any], right_summary: dict[str, Any]) -> dict[str, Any]:
    tie: float
    if goal == 'priority':
        key, tie = 'critical_jobs_completed_on_time', CRITICAL_TIE
        label = 'заданий приоритета 3, завершённых в срок'
    else:
        key, tie = 'revenue_usd', REVENUE_TIE_USD
        label = 'выручки за завершённые в срок задания'
    delta = left_summary.get(key, 0) - right_summary.get(key, 0)
    if abs(delta) <= tie:
        secondary = 'revenue_usd' if goal == 'priority' else 'critical_jobs_completed_on_time'
        tiebreak = left_summary.get(secondary, 0) - right_summary.get(secondary, 0)
        if abs(tiebreak) <= (REVENUE_TIE_USD if secondary == 'revenue_usd' else CRITICAL_TIE):
            return {'winner': None, 'metric': key, 'delta': delta,
                    'text': f'Результаты сопоставимы: одинаково по {label} '
                            'и по дополнительному показателю'}
        winner = left if tiebreak > 0 else right
        return {'winner': winner.id, 'metric': secondary, 'delta': tiebreak,
                'text': f'По {label} ветви равны; перевес даёт '
                        f'дополнительный показатель «{secondary}»'}
    winner = left if delta > 0 else right
    return {'winner': winner.id, 'metric': key, 'delta': delta,
            'text': f'Ветвь «{winner.title}» даёт больше {label}: разница {abs(delta):g}'}


def compare(left: Run, right: Run, goal: str | None = None) -> dict[str, Any]:
    """Differences that matter for the chosen goal, with the caveats attached."""
    goal = goal or left.goal
    left_summary, right_summary = left.session.summary(), right.session.summary()
    rows = []
    for key, better, label in METRICS:
        a, b = left_summary.get(key), right_summary.get(key)
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            continue
        delta = a - b
        if better == 'нейтрально' or delta == 0:
            leader = None
        elif better == 'больше':
            leader = left.id if delta > 0 else right.id
        else:
            leader = left.id if delta < 0 else right.id
        rows.append({'metric': key, 'label': label, 'better': better,
                     'left': a, 'right': b, 'delta': round(delta, 6), 'leader': leader})
    return {
        'goal': goal,
        'left': {'run_id': left.id, 'title': left.title, 'goal': left.goal,
                 'planner': left.planner.name, 'step': left.step, 'summary': left_summary},
        'right': {'run_id': right.id, 'title': right.title, 'goal': right.goal,
                  'planner': right.planner.name, 'step': right.step, 'summary': right_summary},
        'metrics': rows,
        'comparability': _comparability(left, right),
        'verdict': _verdict(goal, left, right, left_summary, right_summary),
    }
