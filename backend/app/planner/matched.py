"""Тот же планировщик, но ретрансляция раздаётся точным паросочетанием.

Диагностика показала, где жадное правило теряет работу. На перегруженном
сценарии оно оставляет 812 аппарато-шагов незанятыми при том, что задание для
аппарата было, оно ещё успевало к сроку, связь была открыта, заряда хватало и
калибровка держалась. Причина не в выборе заданий, а в способе их раздачи.

Жадное назначение — это жадное паросочетание. Задание берёт самый заряженный
свободный аппарат из своего списка; следующее задание, которому подходил только
этот аппарат, остаётся без исполнителя, хотя первое могло уйти на другой. На
шаге 224 сценария P04 в очереди 230 заданий со списками допустимых аппаратов по
два-четыре — ровно та обстановка, где жадность ошибается.

Здесь тот же отбор заданий и тот же порядок предпочтения, но раздача — поиск
дополняющих путей (алгоритм Куна). Задания предлагаются в порядке ранга, и
каждое получает исполнителя, если путь существует, потеснив уже назначенные на
свободные для них аппараты. Это не может обслужить меньше заданий, чем жадность:
жадное назначение — одно из допустимых паросочетаний, а дополняющие пути только
расширяют текущее.

Наземная связь, упреждающая калибровка и порядок предпочтения не меняются: они
унаследованы без изменений, чтобы сравнение говорило именно о раздаче.
"""
from __future__ import annotations

from .base import StepPlan
from .smart import SmartPlanner
from .view import Job, StepView


class MatchedRelayPlanner(SmartPlanner):
    name = 'cosmostars-match'
    version = '1.0'

    def _place_relay(self, view: StepView, plan: StepPlan) -> None:
        step = view.step
        candidates: list[Job] = []
        for job in view.open_jobs():
            if job['kind'] != 'relay' or job['completed_step'] is not None:
                continue
            if job['deadline_step'] - step < job['remaining_steps']:
                continue  # к сроку не успеет даже на свободном аппарате
            candidates.append(job)
        if not candidates:
            return
        candidates.sort(key=lambda job: self._relay_rank(view, job))

        # Свободные аппараты: занятые связью и калибровкой уже в plan.actions и
        # здесь не рассматриваются — приоритет связи не оспаривается. Полнее
        # заряженные идут первыми, как и в жадном правиле: при равном выборе
        # тратим тот аппарат, чей запас больше.
        free = [sid for sid in view.satellite_ids
                if sid not in plan.actions and view.available(sid)]
        free.sort(key=lambda sid: (-view.soc_pct(sid), sid))
        if not free:
            return
        eligible_free = set(free)

        match: dict[str, Job] = {}
        admissible: dict[tuple[str, str], bool] = {}

        def allowed(sid: str, job: Job) -> bool:
            """Допустима ли пара по модели. Ответ в пределах шага не меняется."""
            key = (sid, job['id'])
            if key not in admissible:
                if sid not in job['eligible_satellites']:
                    admissible[key] = False
                else:
                    ok, _, _ = view.can_execute(sid, {'action': 'job', 'job_id': job['id']})
                    admissible[key] = ok
            return admissible[key]

        def augment(job: Job, seen: set[str]) -> bool:
            for sid in job['eligible_satellites']:
                if sid not in eligible_free or sid in seen or not allowed(sid, job):
                    continue
                seen.add(sid)
                held = match.get(sid)
                if held is None or augment(held, seen):
                    match[sid] = job
                    return True
            return False

        for job in candidates:
            if len(match) == len(free):
                break  # свободных аппаратов не осталось, дальше искать нечего
            augment(job, set())

        # Применяем в порядке ранга: так журнал читается так же, как у жадного
        # правила, и при отказе модели первым пострадает наименее важное.
        for sid, job in sorted(match.items(), key=lambda pair: self._relay_rank(view, pair[1])):
            if not plan.try_job(sid, job):
                # Модель отклонила уже проверенную пару — состояние разошлось с
                # ожиданием, и расписание связи стоит пересобрать.
                self._stale = True


__all__ = ['MatchedRelayPlanner']
