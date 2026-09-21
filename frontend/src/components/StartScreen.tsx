import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Radio, Upload } from 'lucide-react'
import { api, useRuns, useScenarios, ApiError } from '../api/client'
import type { Goal, ScenarioBrief } from '../api/types'
import { useConsole } from '../store'
import { Chip, Failure, Loading, num, usd } from '../ui'

const GOALS: { id: Goal; label: string; note: string }[] = [
  { id: 'priority', label: 'приоритет', note: 'сначала обязательства третьего приоритета' },
  { id: 'revenue', label: 'выручка', note: 'сначала самые дорогие задания' },
]

export function StartScreen() {
  const { data, isPending, error } = useScenarios()
  const { data: runs } = useRuns()
  const openRun = useConsole((s) => s.openRun)
  const client = useQueryClient()
  const [goal, setGoal] = useState<Goal>('priority')
  const [planner, setPlanner] = useState('cosmostars')
  const [picked, setPicked] = useState<string | null>(null)

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
              <option value="cosmostars">cosmostars · точная связь + жадная ретрансляция</option>
              <option value="baseline-edf">baseline-edf · простое правило по сроку</option>
              <option value="cosmostars-match">cosmostars-match · ретрансляция паросочетанием</option>
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

function ScenarioCard({ item, active, busy, onPick }: {
  item: ScenarioBrief; active: boolean; busy: boolean; onPick: () => void
}) {
  return (
    <article className={'scn' + (active ? ' active' : '')}>
      <header>
        <h3>{item.key}</h3>
        <span>{item.title}</span>
      </header>
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
