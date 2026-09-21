import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Radio, SlidersHorizontal, Upload } from 'lucide-react'
import { api, useRuns, useScenarios, usePlanners, ApiError, type DeriveBody } from '../api/client'
import type { DerivedFrom, Goal, ScenarioBrief } from '../api/types'
import { useConsole } from '../store'
import { Chip, Failure, Loading, Note, num, usd } from '../ui'

const GOALS: { id: Goal; label: string; note: string }[] = [
  { id: 'priority', label: 'приоритет', note: 'сначала обязательства третьего приоритета' },
  { id: 'revenue', label: 'выручка', note: 'сначала самые дорогие задания' },
]

// One line per planner. The list itself comes from the service, so a planner
// added there shows up here without a second edit; the note is the only thing
// the interface knows on its own.
const PLANNER_NOTES: Record<string, string> = {
  cosmostars: 'точная связь + жадная ретрансляция',
  'baseline-edf': 'простое правило по сроку',
  'cosmostars-match': 'ретрансляция паросочетанием',
}

export function StartScreen() {
  const { data, isPending, error } = useScenarios()
  const { data: runs } = useRuns()
  const planners = usePlanners()
  const openRun = useConsole((s) => s.openRun)
  const client = useQueryClient()
  const [goal, setGoal] = useState<Goal>('priority')
  const [planner, setPlanner] = useState('cosmostars')
  const [picked, setPicked] = useState<string | null>(null)

  const plannerList = planners.data?.planners
    ?? Object.keys(PLANNER_NOTES).map((name) => ({ name, version: '' }))

  const create = useMutation<unknown, ApiError, { scenario_key: string }>({
    mutationFn: ({ scenario_key }) => api.createRun({ scenario_key, goal, planner }),
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

  return (
    <div className="start">
      <div className="wrap">
        <header className="start-head">
          <div className="brand">
            <b>Пульт наземной смены</b>
            <span><Radio size={12} aria-hidden /> Cosmostars · автономное управление группировкой</span>
          </div>
          <p>
            Выберите смену, цель управления и планировщик. Расчёт мгновенный: смена считается
            целиком, а проигрывание идёт по записанной истории — ждать пять минут за каждый
            шаг модели не нужно.
          </p>
        </header>

        <Failure error={create.error ?? error} what="Смену открыть не удалось" />
        <Failure error={upload.error as ApiError | null} what="Сценарий не принят" />

        <div className="start-controls">
          <div className="field">
            <label>Цель управления</label>
            <div className="seg" role="group">
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
            <span className="hint">
              Третий — тот же наш планировщик с одной заменой: ретрансляция раздаётся точным
              паросочетанием. На перегрузке он берёт больше выручки и меньше обязательств,
              то есть проигрывает под целью «приоритет». Сравните сами на вкладке «Ветви».
            </span>
          </div>
          <label className="btn upload">
            <Upload size={14} aria-hidden /> Свой сценарий
            <input type="file" accept="application/json" hidden
                   onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </label>
        </div>

        <DeriveConditions
          scenarios={data?.items ?? []}
          onSaved={(item) => {
            client.invalidateQueries({ queryKey: ['scenarios'] })
            setPicked(item.key)
          }}
        />

        {isPending && <Loading what="Каталог смен" />}
        <div className="cards">
          {data?.items.map((item) => (
            <ScenarioCard
              key={item.key}
              item={item}
              active={picked === item.key}
              busy={create.isPending && picked === item.key}
              onPick={() => { setPicked(item.key); create.mutate({ scenario_key: item.key }) }}
            />
          ))}
        </div>

        {!!runs?.items.length && (
          <div className="start-runs">
            <h2>Уже открытые смены</h2>
            <ul>
              {runs.items.map((item) => (
                <li key={item.run_id}>
                  <button className="btn" onClick={() => openRun(item.run_id)}>
                    <span className="mono">{item.run_id.slice(0, 6)}</span> {item.title}
                    <Chip>{item.step} / {item.total_steps}</Chip>
                    {item.parent_id && <Chip tone="good">ветвь</Chip>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
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
      {saved && <Note><span>Сохранён сценарий <b>{saved}</b> — он появился в каталоге ниже.</span></Note>}
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
  return `из ${origin.scenario}: ${parts.join(', ')}`
}

function ScenarioCard({ item, active, busy, onPick }: {
  item: ScenarioBrief; active: boolean; busy: boolean; onPick: () => void
}) {
  return (
    <article className={'scn' + (active ? ' active' : '')}>
      <header>
        <h3>{item.key}</h3>
        <span>{item.title}</span>
        {item.source === 'derived' && <Chip tone="cert">изменённые условия</Chip>}
        {item.source === 'uploaded' && <Chip>загружен</Chip>}
      </header>
      {item.derived_from && <p className="changes">{describeChanges(item.derived_from)}</p>}
      <dl className="dl">
        <dt>Аппаратов</dt><dd>{item.satellites}</dd>
        <dt>Заданий</dt><dd>{num(item.jobs_total)}</dd>
        <dt>из них связь</dt><dd>{num(item.jobs_downlink)}</dd>
        <dt>Приоритет 3</dt><dd>{num(item.jobs_by_priority['3'])}</dd>
        <dt>Цена смены</dt><dd>{usd(item.value_total_usd)}</dd>
        <dt>Длительность</dt><dd>{item.steps} шагов · {item.duration_hours} ч</dd>
        <dt>Известные отказы</dt><dd>{item.known_outages}</dd>
      </dl>
      <button className="btn primary" onClick={onPick} disabled={busy}>
        <Play size={14} aria-hidden /> {busy ? 'Открываем…' : 'Открыть смену'}
      </button>
    </article>
  )
}
