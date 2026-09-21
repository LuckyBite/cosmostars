import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, SlidersHorizontal, Upload } from 'lucide-react'
import { api, useRuns, useScenarios, usePlanners, ApiError, type DeriveBody } from '../api/client'
import type { DerivedFrom, Goal, ScenarioBrief } from '../api/types'
import { useConsole } from '../store'
import { Chip, Failure, Loading, Note, num, usd } from '../ui'
import { Mark } from './Mark'

// The launch parameters used to sit above the cards and apply to whichever card
// was clicked — invisibly. Now a card is only a choice, and everything that
// decides how the shift will run lives in one pinned bar with the button that
// starts it. What you set is next to what it sets.

const GOALS: { id: Goal; label: string; note: string }[] = [
  { id: 'priority', label: 'Приоритет', note: 'Сначала обязательства третьего приоритета' },
  { id: 'revenue', label: 'Выручка', note: 'Сначала самые дорогие задания' },
]

// One line per planner. The list itself comes from the service, so a planner
// added there shows up here without a second edit; the note is the only thing
// the interface knows on its own.
const PLANNER_NOTES: Record<string, string> = {
  cosmostars: 'точная связь + жадная ретрансляция',
  'baseline-edf': 'простое правило по сроку',
  'cosmostars-match': 'ретрансляция паросочетанием',
}

const QUICK_SCENARIO = 'P02_shift'

export function StartScreen() {
  const { data, isPending, error } = useScenarios()
  const { data: runs } = useRuns()
  const planners = usePlanners()
  const openRun = useConsole((s) => s.openRun)
  const client = useQueryClient()
  const [goal, setGoal] = useState<Goal>('priority')
  const [planner, setPlanner] = useState('cosmostars')
  const [picked, setPicked] = useState<string | null>(null)
  const [quick, setQuick] = useState(false)

  const scenarios = data?.items ?? []
  const plannerList = planners.data?.planners
    ?? Object.keys(PLANNER_NOTES).map((name) => ({ name, version: '' }))

  const chosen = scenarios.find((item) => item.key === picked)
    ?? scenarios.find((item) => item.key === QUICK_SCENARIO)
    ?? scenarios[0]

  const create = useMutation<unknown, ApiError, { scenario_key: string }>({
    mutationFn: ({ scenario_key }) => api.createRun({ scenario_key, goal, planner }),
    onSuccess: (run) => {
      client.invalidateQueries({ queryKey: ['runs'] })
      openRun((run as { run_id: string }).run_id)
    },
  })

  // The short path: one press computes the whole day and opens the summary,
  // because a demonstration that starts with a form is a demonstration lost.
  const show = useMutation<unknown, ApiError, void>({
    mutationFn: async () => {
      const run = await api.createRun({
        scenario_key: QUICK_SCENARIO, goal: 'priority', planner: 'cosmostars',
      }) as { run_id: string; total_steps: number }
      await api.advance(run.run_id, { to_step: run.total_steps })
      return run
    },
    onSuccess: (run) => {
      client.invalidateQueries({ queryKey: ['runs'] })
      openRun((run as { run_id: string }).run_id)
    },
  })

  const upload = useMutation<unknown, ApiError, File>({
    mutationFn: async (file) => {
      const text = await file.text()
      const key = file.name.replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
      return api.uploadScenario(key, JSON.parse(text))
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['scenarios'] }),
  })

  const busy = create.isPending || show.isPending

  return (
    <div className="start">
      <div className="start-body">
        <div className="start-inner">
          <div className="start-top">
            <div className="start-hero">
              <div className="line">
                <Mark size={26} />
                <b>Пульт наземной смены</b>
              </div>
              <div className="kicker">Cosmostars · автономное управление группировкой</div>
              <p>
                Смена считается целиком и мгновенно, а проигрывается по записанной истории.
                Выберите смену — цель управления и планировщик задаются перед запуском, внизу.
              </p>
            </div>

            <div className="quick">
              <span className="k">Короткий путь</span>
              <b>Демонстрация за три минуты</b>
              <p>
                Суточная смена {QUICK_SCENARIO} считается целиком, открывается итог с потолком
                выполнимости и разбором потерь.
              </p>
              <button className="btn primary" disabled={busy}
                      onClick={() => { setQuick(true); show.mutate() }}>
                <Play size={14} fill="currentColor" strokeWidth={0} aria-hidden />
                {show.isPending && quick ? 'Считаем смену…' : 'Запустить показ'}
              </button>
            </div>
          </div>

          <Failure error={create.error ?? show.error ?? error} what="Смену открыть не удалось" />
          <Failure error={upload.error as ApiError | null} what="Сценарий не принят" />

          <div className="start-section">
            <header>
              <h2>Смены кейса</h2>
              <span>Шаг модели — 5 минут. Выберите карточку, параметры запуска ниже.</span>
            </header>
            {isPending && <Loading what="Каталог смен" />}
            <div className="cards">
              {scenarios.map((item) => (
                <ScenarioCard key={item.key} item={item}
                              active={chosen?.key === item.key}
                              onPick={() => setPicked(item.key)} />
              ))}
            </div>
          </div>

          <details className="start-more">
            <summary>
              Уже открытые смены{runs?.items.length ? ` · ${runs.items.length}` : ''} ·
              и загрузка своего сценария
            </summary>
            <div className="body">
              {runs?.items.map((item) => (
                <div className="run-row" key={item.run_id}>
                  <span className="mono">{item.run_id.slice(0, 6)}</span>
                  <span>{item.scenario_key} · {item.goal === 'priority' ? 'приоритет' : 'выручка'}</span>
                  <Chip>{item.step} / {item.total_steps}</Chip>
                  {item.parent_id && <Chip tone="good">Ветвь</Chip>}
                  <button className="btn" onClick={() => openRun(item.run_id)}>Открыть</button>
                </div>
              ))}
              {!runs?.items.length && <p className="tbl-note">Открытых смен пока нет.</p>}
              <label className="btn upload">
                <Upload size={14} aria-hidden /> Загрузить свой сценарий
                <input type="file" accept="application/json" hidden
                       onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
              </label>
            </div>
          </details>

          <DeriveConditions
            scenarios={scenarios}
            onSaved={(item) => {
              client.invalidateQueries({ queryKey: ['scenarios'] })
              setPicked(item.key)
            }}
          />
        </div>
      </div>

      <div className="launch">
        <div className="launch-inner">
          <div className="launch-what">
            <span className="k">К запуску</span>
            <b>{chosen?.key ?? '—'}</b>
            <span>{chosen?.title ?? 'Каталог ещё загружается'}</span>
          </div>

          <div className="field">
            <label id="start-goal">Цель управления</label>
            <div className="seg" role="group" aria-labelledby="start-goal">
              {GOALS.map((item) => (
                <button key={item.id} aria-pressed={goal === item.id} title={item.note}
                        onClick={() => setGoal(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="planner">Планировщик</label>
            <select id="planner" value={planner} onChange={(e) => setPlanner(e.target.value)}>
              {plannerList.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}{PLANNER_NOTES[item.name] ? ` · ${PLANNER_NOTES[item.name]}` : ''}
                </option>
              ))}
            </select>
          </div>

          <button className="btn primary" disabled={!chosen || busy}
                  onClick={() => { setQuick(false); chosen && create.mutate({ scenario_key: chosen.key }) }}>
            <Play size={14} fill="currentColor" strokeWidth={0} aria-hidden />
            {create.isPending ? 'Открываем…' : 'Открыть смену'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** How hard this scenario leans on the constellation, from the catalogue alone.
 *
 *  The real supply of contact windows is only known once a shift is open, so the
 *  bar is drawn against the one bound the catalogue itself states: every
 *  satellite for every step of the shift. A scenario that crosses that mark asks
 *  for more work than the constellation physically has time to do, whatever the
 *  planner decides — which is exactly what separates P04 from the rest. */
function demand(item: ScenarioBrief) {
  const supply = Math.max(item.steps * item.satellites, 1)
  const ratio = item.work_steps_total / supply
  const mood = item.steps <= 48
    ? { tone: 'var(--s1)', text: 'Короткая. Для знакомства с пультом' }
    : ratio >= 1
      ? { tone: 'var(--crit)', text: 'Перегрузка. Работы больше, чем аппарато-шагов' }
      : ratio >= 0.5
        ? { tone: 'var(--warn)', text: 'Плотно. Ресурс смены расписан почти весь' }
        : { tone: 'var(--s3)', text: 'Норма. Работа укладывается в ресурс' }
  return { supply, ratio, ...mood }
}

function ScenarioCard({ item, active, onPick }: {
  item: ScenarioBrief; active: boolean; onPick: () => void
}) {
  const load = demand(item)
  return (
    <button className="scn" aria-pressed={active} onClick={onPick}
            style={{ ['--tone' as string]: load.tone }}>
      <div className="scn-head">
        <div className="scn-key">
          <b>{item.key}</b>
          <span>{item.steps} шагов</span>
        </div>
        <span>{item.title}</span>
        {item.source === 'derived' && <Chip tone="cert">Изменённые условия</Chip>}
        {item.source === 'uploaded' && <Chip>Загружен</Chip>}
      </div>

      <div className="scn-mood"><i />{load.text}</div>

      <div className="scn-nums">
        <div><span>Аппаратов</span><b>{item.satellites}</b></div>
        <div><span>Заданий</span><b>{num(item.jobs_total)}</b></div>
        <div><span>Приоритет 3</span><b>{num(item.jobs_by_priority['3'] ?? 0)}</b></div>
      </div>

      <div className="scn-demand">
        <div className="row">
          <span>Спрос на группировку</span>
          <b>{num(item.work_steps_total)} / {num(load.supply)}</b>
        </div>
        <div className="track">
          <i style={{ width: `${Math.min(100, 100 * load.ratio)}%` }} />
          <u style={{ left: '100%' }} />
        </div>
        <span>Аппарато-шаги работы против всего ресурса смены</span>
      </div>

      {item.derived_from && <p className="changes">{describeChanges(item.derived_from)}</p>}
      <p className="changes">
        Цена смены {usd(item.value_total_usd)} · заданий связи {num(item.jobs_downlink)}
        {' '}при пределе {item.downlink_parallel_limit} передачи на шаг
      </p>
    </button>
  )
}

/** The pre-run changes the statement allows, saved as a scenario of their own.
 *
 *  Four fields and nothing else: the initial charge of one satellite, the solar
 *  power coefficient, the priority of an existing job, a period of
 *  unavailability. Powers, prices and model rules are not on offer — changing
 *  them would be a different experiment, not a setting. */
function DeriveConditions({ scenarios, onSaved }: {
  scenarios: ScenarioBrief[]; onSaved: (item: ScenarioBrief) => void
}) {
  const bundled = scenarios.filter((item) => item.source === 'bundled')
  const [base, setBase] = useState('P02_shift')
  const baseKey = bundled.some((item) => item.key === base) ? base : (bundled[0]?.key ?? '')
  const [sat, setSat] = useState('')
  const [soc, setSoc] = useState('')
  const [solar, setSolar] = useState('')
  const [jobId, setJobId] = useState('')
  const [priority, setPriority] = useState('')
  const [outSat, setOutSat] = useState('')
  const [outFrom, setOutFrom] = useState('')
  const [outTo, setOutTo] = useState('')
  const [saved, setSaved] = useState<string | null>(null)

  const body = (): DeriveBody => {
    const out: DeriveBody = {}
    if (sat.trim() && soc !== '') out.initial_soc_pct = { [sat.trim().toUpperCase()]: Number(soc) }
    if (solar !== '') out.solar_multiplier = Number(solar)
    if (jobId.trim() && priority !== '') out.job_priority = { [jobId.trim().toUpperCase()]: Number(priority) }
    if (outSat.trim() && outFrom !== '' && outTo !== '') {
      out.outages = [{ satellite_id: outSat.trim().toUpperCase(),
                       start_step: Number(outFrom), end_step: Number(outTo) }]
    }
    return out
  }
  const ready = !!baseKey && Object.keys(body()).length > 0

  const derive = useMutation<ScenarioBrief, ApiError, void>({
    mutationFn: () => api.deriveScenario(baseKey, body()),
    onSuccess: (item) => { setSaved(item.key); onSaved(item) },
  })

  const digits = (value: string) => value.replace(/[^\d.]/g, '')

  return (
    <details className="derive">
      <summary><SlidersHorizontal size={14} aria-hidden /> Изменить условия смены до запуска</summary>
      <p>
        Постановка разрешает четыре изменения до расчёта: начальный заряд аппарата, коэффициент
        солнечной мощности, приоритет существующего задания и период недоступности. Изменённый
        вариант сохраняется отдельным сценарием со своим идентификатором: сравнение с исходной
        сменой честно предупредит, что условия разные, а выгрузка запомнит, что именно изменили.
      </p>
      <Failure error={derive.error} what="Сценарий не сохранён" />
      {saved && <Note><span>Сохранён сценарий <b>{saved}</b> — он появился в каталоге выше.</span></Note>}
      <div className="event-forms">
        <div className="field wide">
          <label htmlFor="d-base">Исходный сценарий</label>
          <select id="d-base" value={baseKey} onChange={(e) => setBase(e.target.value)}>
            {bundled.map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-sat">Аппарат</label>
          <input id="d-sat" placeholder="S01" value={sat} onChange={(e) => setSat(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-soc">Начальный заряд, %</label>
          <input id="d-soc" inputMode="decimal" placeholder="40" value={soc}
                 onChange={(e) => setSoc(digits(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="d-solar">Солнечная мощность, ×</label>
          <input id="d-solar" inputMode="decimal" placeholder="0.6" value={solar}
                 onChange={(e) => setSolar(digits(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="d-job">Задание</label>
          <input id="d-job" placeholder="JOB-0001" value={jobId} onChange={(e) => setJobId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-prio">Приоритет</label>
          <select id="d-prio" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option><option value="1">1</option>
            <option value="2">2</option><option value="3">3</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-osat">Недоступен аппарат</label>
          <input id="d-osat" placeholder="S05" value={outSat} onChange={(e) => setOutSat(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-from">С шага</label>
          <input id="d-from" inputMode="numeric" placeholder="10" value={outFrom}
                 onChange={(e) => setOutFrom(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="d-to">До шага</label>
          <input id="d-to" inputMode="numeric" placeholder="30" value={outTo}
                 onChange={(e) => setOutTo(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="acts">
          <button className="btn primary" disabled={!ready || derive.isPending}
                  onClick={() => derive.mutate()}>
            {derive.isPending ? 'Сохраняем…' : 'Сохранить как новый сценарий'}
          </button>
        </div>
      </div>
    </details>
  )
}

function describeChanges(origin: DerivedFrom): string {
  const parts: string[] = []
  for (const [sid, soc] of Object.entries(origin.changes.initial_soc_pct ?? {})) {
    parts.push(`заряд ${sid} → ${soc}%`)
  }
  if (origin.changes.solar_multiplier !== undefined) parts.push(`солнце ×${origin.changes.solar_multiplier}`)
  for (const [job, value] of Object.entries(origin.changes.job_priority ?? {})) {
    parts.push(`приоритет ${job} → ${value}`)
  }
  for (const outage of origin.changes.outages ?? []) {
    parts.push(`${outage.satellite_id} недоступен ${outage.start_step}–${outage.end_step}`)
  }
  return `Из ${origin.scenario}: ${parts.join(', ')}`
}
