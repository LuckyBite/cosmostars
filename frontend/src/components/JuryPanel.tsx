import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2 } from 'lucide-react'
import { api, runKey } from '../api/client'
import type { CaseEvent, Goal, RunInfo } from '../api/types'
import { useConsole, type Tab } from '../store'
import { Card, Chip, Note } from '../ui'

// The routes below exist because a good screen that nobody finds scores zero.
// Each one sets a shift up to the exact state where a criterion can be checked
// and opens the screen that answers it — in a few seconds, without the operator
// having to know our menu.

interface Ctx {
  open: (runId: string) => void
  tab: (tab: Tab) => void
  selectJob: (jobId: string | null) => void
  compare: (side: 'left' | 'right', runId: string) => void
  say: (text: string) => void
}

interface Route {
  id: string
  criteria: string
  title: string
  what: string
  run: (ctx: Ctx) => Promise<void>
}

const demoJobs = (step: number, sats: string[], total: number): CaseEvent => {
  const slack = Math.max(2, Math.min(10, total - step))
  return {
    id: `JURY-jobs-${step}`,
    at_step: step,
    type: 'add_jobs',
    jobs: [
      { id: `JURY-URG-${step}-1`, kind: 'relay', release_step: step, deadline_step: step + slack,
        work_steps: Math.min(3, slack), eligible_satellites: sats.slice(0, 3), priority: 3, value_usd: 40 },
      { id: `JURY-URG-${step}-2`, kind: 'relay', release_step: step, deadline_step: step + slack,
        work_steps: Math.min(2, slack), eligible_satellites: sats.slice(0, 3), priority: 3, value_usd: 70 },
    ],
  }
}

const start = async (scenario: string, goal: Goal, planner = 'cosmostars', title?: string) =>
  api.createRun({ scenario_key: scenario, goal, planner, title })

const satellitesOf = async (run: RunInfo) =>
  (await api.satellites(run.run_id)).items.map((item) => item.satellite_id)

const ROUTES: Route[] = [
  {
    id: 'ceiling',
    criteria: 'О1 · О3',
    title: 'Результат смены и потолок выполнимости',
    what: 'Считает сутки на P02 целиком и открывает итог: обязательства, выручка, ресурсы — и рядом верхняя граница по связи с ценой недостижимого.',
    run: async (ctx) => {
      const run = await start('P02_shift', 'priority', 'cosmostars', 'Показ · итог смены')
      ctx.say('Считаем 288 шагов…')
      await api.advance(run.run_id, { to_step: run.total_steps })
      ctx.open(run.run_id)
      ctx.tab('shift')
    },
  },
  {
    id: 'fog',
    criteria: 'Т3 · О5',
    title: 'Новые сведения не переписывают прошлое',
    what: 'Останавливает смену перед шагом 72 и открывает полотно. Дальше вбросьте сообщение на вкладке «Смена» — перерисуется только правая часть, левая не сдвинется.',
    run: async (ctx) => {
      const run = await start('P02_shift', 'priority', 'cosmostars', 'Показ · туман войны')
      await api.advance(run.run_id, { to_step: 72 })
      ctx.open(run.run_id)
      ctx.tab('canvas')
      ctx.say('Смена остановлена перед шагом 72. Полотно слева — факт, справа — намерение.')
    },
  },
  {
    id: 'events',
    criteria: 'О2',
    title: 'Работа при изменениях обстановки',
    what: 'Доводит смену до шага 72, принимает срочные задания и отмену сеансов на трёх аппаратах, продолжает до 120 и показывает, что удалось сохранить.',
    run: async (ctx) => {
      const run = await start('P02_shift', 'priority', 'cosmostars', 'Показ · сообщения')
      await api.advance(run.run_id, { to_step: 72 })
      const sats = await satellitesOf(run)
      ctx.say('Принимаем срочные задания…')
      await api.event(run.run_id, demoJobs(72, sats, run.total_steps))
      ctx.say('Отменяем сеансы связи на трёх аппаратах…')
      await api.closeDownlink(run.run_id, { satellite_ids: sats.slice(8, 11), end_step: 180 })
      await api.advance(run.run_id, { to_step: 120 })
      ctx.open(run.run_id)
      ctx.tab('shift')
      ctx.say('Сообщения приняты на шаге 72, расчёт продолжен до 120 без пересчёта прошлого.')
    },
  },
  {
    id: 'why',
    criteria: 'О3',
    title: 'Почему задание не вышло',
    what: 'Считает смену и открывает первое просроченное задание связи с разбором: сертификат против данных, конкуренция за контакт, отказ аппарата.',
    run: async (ctx) => {
      const run = await start('P02_shift', 'priority', 'cosmostars', 'Показ · разбор потерь')
      await api.advance(run.run_id, { to_step: run.total_steps })
      const missed = await api.jobs(run.run_id, { status: 'missed', limit: 50 })
      const target = missed.items.find((item) => item.kind === 'downlink') ?? missed.items[0]
      ctx.open(run.run_id)
      ctx.tab('jobs')
      if (target) {
        ctx.selectJob(target.job_id)
        ctx.say(`Открыто задание ${target.job_id} из ${missed.total} просроченных.`)
      }
    },
  },
  {
    id: 'branches',
    criteria: 'О4',
    title: 'Две цели управления из одного состояния',
    what: 'Берёт P04 с перегрузкой, доводит до шага 72, делает ветвь, переключает её на выручку и досчитывает обе. Цели расходятся только при дефиците — здесь он есть, и видно, чем платит каждая.',
    run: async (ctx) => {
      const base = await start('P04_demand', 'priority', 'cosmostars', 'Показ · цель приоритет')
      await api.advance(base.run_id, { to_step: 72 })
      const branch = await api.fork(base.run_id, 'Показ · цель выручка')
      await api.setGoal(branch.run_id, 'revenue')
      ctx.say('Досчитываем обе ветви до конца смены…')
      await api.advance(base.run_id, { to_step: base.total_steps })
      await api.advance(branch.run_id, { to_step: base.total_steps })
      ctx.compare('left', base.run_id)
      ctx.compare('right', branch.run_id)
      ctx.open(base.run_id)
      ctx.tab('branches')
      ctx.say('Ветви разошлись на шаге 72 из одного состояния и получили одинаковые условия.')
    },
  },
  {
    id: 'baseline',
    criteria: 'Т2 · Т4',
    title: 'Наш планировщик против простого правила',
    what: 'Гоняет P03 с дефицитом энергии двумя планировщиками на одних условиях и ставит их рядом в сравнении.',
    run: async (ctx) => {
      const ours = await start('P03_energy', 'priority', 'cosmostars', 'Показ · cosmostars на P03')
      const base = await start('P03_energy', 'priority', 'baseline-edf', 'Показ · baseline-edf на P03')
      ctx.say('Считаем обе смены целиком…')
      await api.advance(ours.run_id, { to_step: ours.total_steps })
      await api.advance(base.run_id, { to_step: base.total_steps })
      ctx.compare('left', ours.run_id)
      ctx.compare('right', base.run_id)
      ctx.open(ours.run_id)
      ctx.tab('branches')
      ctx.say('Два независимых запуска на одном сценарии: сравнение честно предупредит, что общего состояния у них нет.')
    },
  },
  {
    id: 'verify',
    criteria: 'Т1 · Т6',
    title: 'Проверка расчёта в браузере',
    what: 'Считает смену и прогоняет её выгрузку через replay_episode выданной библиотеки: хеш сценария, сводка и журнал построчно.',
    run: async (ctx) => {
      const run = await start('P02_shift', 'priority', 'cosmostars', 'Показ · воспроизводимость')
      await api.advance(run.run_id, { to_step: run.total_steps })
      ctx.open(run.run_id)
      ctx.tab('verify')
      ctx.say('Нажмите «проверить текущую смену» — расчёт пересчитается выданной библиотекой.')
    },
  },
  {
    id: 'demand',
    criteria: 'Т2',
    title: 'Поведение при перегрузке',
    what: 'Открывает P04 — 8120 заданий на те же 458 окон связи. Там цели расходятся, и видно, чем именно платит каждая.',
    run: async (ctx) => {
      const run = await start('P04_demand', 'priority', 'cosmostars', 'Показ · перегрузка')
      ctx.say('Считаем 8120 заданий…')
      await api.advance(run.run_id, { to_step: run.total_steps })
      ctx.open(run.run_id)
      ctx.tab('shift')
    },
  },
]

export function JuryPanel({ run }: { run: RunInfo }) {
  const client = useQueryClient()
  const openRun = useConsole((s) => s.openRun)
  const setTab = useConsole((s) => s.setTab)
  const selectJob = useConsole((s) => s.selectJob)
  const setCompare = useConsole((s) => s.setCompare)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const go = async (route: Route) => {
    setBusy(route.id)
    setFailure(null)
    setNote(null)
    try {
      await route.run({
        open: openRun,
        tab: setTab,
        selectJob,
        compare: setCompare,
        say: setNote,
      })
      client.invalidateQueries({ queryKey: ['runs'] })
      client.invalidateQueries({ queryKey: runKey(null) })
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Card title="Показ — маршруты по критериям"
            note="Каждая кнопка приводит сервис в состояние, где соответствующий критерий проверяется своими руками, и открывает нужный экран. Ничего не имитируется: это обычные запросы к тому же API.">
        {note && <Note><span>{note}</span></Note>}
        {failure && <div className="note failure"><span><b>Маршрут не прошёл.</b> {failure}</span></div>}
        <div className="routes">
          {ROUTES.map((route) => (
            <article key={route.id} className="route">
              <header>
                <Chip tone="cert">{route.criteria}</Chip>
                <h3>{route.title}</h3>
              </header>
              <p>{route.what}</p>
              <button className="btn" disabled={!!busy} onClick={() => go(route)}>
                {busy === route.id
                  ? <><Loader2 size={14} className="spin" aria-hidden /> Готовим…</>
                  : <>Показать <ArrowRight size={14} aria-hidden /></>}
              </button>
            </article>
          ))}
        </div>
      </Card>

      <Card title="Где что лежит"
            note="Короткая карта пульта, чтобы не искать вслепую.">
        <dl className="dl">
          <dt>Смена</dt>
          <dd>итог на курсоре, потолок выполнимости, полоса связи с ценой слота, приём сообщений</dd>
          <dt>Полотно</dt>
          <dd>{run.summary.jobs_total ? 'сетка аппараты × шаги: слева факт, справа намерение' : 'сетка смены'}</dd>
          <dt>Аппараты</dt>
          <dd>заряд, температура, калибровка, журнал команд с причинами отказов</dd>
          <dt>Задания</dt>
          <dd>фильтры и трёхслойный разбор «почему не вышло»</dd>
          <dt>Ветви</dt>
          <dd>дерево смены по шагу ветвления и сравнение пары с проверкой сопоставимости</dd>
          <dt>Проверка</dt>
          <dd>пересчёт выгрузки выданной библиотекой прямо в браузере</dd>
          <dt>Показ</dt>
          <dd>этот экран: маршруты, которые приводят пульт в нужное состояние одним нажатием</dd>
        </dl>
        <p className="tbl-note">
          Регламент защиты короткий, поэтому маршруты сделаны в один клик. Любой из них можно
          пройти и вручную: кнопки в шапке и на вкладке «Смена» делают ровно то же самое.
        </p>
      </Card>
    </>
  )
}
