import { useMemo, useState } from 'react'
import { useFeasibility, useJobs } from '../api/client'
import type { JobRow, JobState, RunInfo } from '../api/types'
import { useConsole } from '../store'
import { Card, Chip, Empty, Failure, Loading, Meter, num, usd } from '../ui'
import { JobExplain } from './JobExplain'

const FILTERS: { id: JobState | 'all'; label: string }[] = [
  { id: 'missed', label: 'просроченные' },
  { id: 'open', label: 'в работе' },
  { id: 'completed', label: 'выполненные' },
  { id: 'pending', label: 'ещё не открылись' },
  { id: 'all', label: 'все' },
]

const STATES: Record<JobState, { label: string; tone?: 'good' | 'crit' | 'warn' }> = {
  completed: { label: 'выполнено', tone: 'good' },
  missed: { label: 'просрочено', tone: 'crit' },
  open: { label: 'в работе' },
  pending: { label: 'ждёт окна' },
}

export function JobsPanel({ run }: { run: RunInfo }) {
  const [filter, setFilter] = useState<JobState | 'all'>('missed')
  const [kind, setKind] = useState<'all' | 'downlink' | 'relay'>('all')
  const [search, setSearch] = useState('')
  const [onlyCritical, setOnlyCritical] = useState(false)
  const selectedJob = useConsole((s) => s.selectedJob)
  const selectJob = useConsole((s) => s.selectJob)

  const jobs = useJobs(run.run_id, filter, 1000)
  const feas = useFeasibility(run.run_id)

  const certified = useMemo(
    () => new Set((feas.data?.impossible_jobs ?? []).map((item) => item.job_id)),
    [feas.data])

  const rows = useMemo(() => {
    const needle = search.trim().toUpperCase()
    return (jobs.data?.items ?? []).filter((row) =>
      (kind === 'all' || row.kind === kind) &&
      (!onlyCritical || row.priority === 3) &&
      (!needle || row.job_id.includes(needle) || row.eligible_satellites.some((sid) => sid.includes(needle))))
  }, [jobs.data, kind, onlyCritical, search])

  return (
    <>
      <Failure error={jobs.error} what="Список заданий не загрузился" />
      <div className="jobs-layout">
        <Card title="Задания смены"
              note="Строка — задание. Клик открывает разбор: почему оно вышло или не вышло, с доказательством, а не с общими словами.">
          <div className="filters">
            {FILTERS.map((item) => (
              <button key={item.id} className="pill" aria-pressed={filter === item.id}
                      onClick={() => setFilter(item.id)}>{item.label}</button>
            ))}
            <span className="sep" />
            {(['all', 'downlink', 'relay'] as const).map((item) => (
              <button key={item} className="pill" aria-pressed={kind === item}
                      onClick={() => setKind(item)}>
                {item === 'all' ? 'любой тип' : item === 'downlink' ? 'связь' : 'ретрансляция'}
              </button>
            ))}
            <button className="pill" aria-pressed={onlyCritical}
                    onClick={() => setOnlyCritical((v) => !v)}>только приоритет 3</button>
            <input type="search" placeholder="JOB-0015 или S03" value={search}
                   onChange={(e) => setSearch(e.target.value)} aria-label="Поиск по заданию или аппарату" />
          </div>

          {jobs.isPending ? <Loading what="Задания" /> : rows.length === 0 ? (
            <Empty>Под фильтр ничего не попало.</Empty>
          ) : (
            <div className="scroll jobs-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Задание</th><th>Тип</th><th className="num">Приоритет</th>
                    <th className="num">Цена</th><th>Окно</th><th>Прогресс</th>
                    <th>Исполнители</th><th>Состояние</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 300).map((row) => (
                    <JobLine key={row.job_id} row={row} selected={row.job_id === selectedJob}
                             certified={certified.has(row.job_id)}
                             onPick={() => selectJob(row.job_id)} />
                  ))}
                </tbody>
              </table>
              <p className="tbl-note">
                Показано {num(Math.min(rows.length, 300))} из {num(jobs.data?.total ?? 0)} по фильтру
                «{FILTERS.find((item) => item.id === filter)?.label}».
                {certified.size > 0 && <> Пунктирная метка — сертификат невыполнимости
                  ({num(certified.size)} заданий).</>}
              </p>
            </div>
          )}
        </Card>

        <JobExplain run={run} />
      </div>
    </>
  )
}

function JobLine({ row, selected, certified, onPick }: {
  row: JobRow; selected: boolean; certified: boolean; onPick: () => void
}) {
  const state = STATES[row.state]
  return (
    <tr aria-selected={selected} onClick={onPick}>
      <td className="id">{row.job_id}</td>
      <td>{row.kind === 'downlink' ? 'связь' : 'ретрансляция'}</td>
      <td className="num">{row.priority === 3 ? <Chip tone="warn">3</Chip> : row.priority}</td>
      <td className="num">{usd(row.value_usd)}</td>
      <td className="id">{row.release_step}–{row.deadline_step}</td>
      <td><Meter value={(100 * row.progress_steps) / row.work_steps}
                 tone={row.state === 'completed' ? 'var(--good)' : undefined} /></td>
      <td className="id">{row.eligible_satellites.slice(0, 3).join(' ')}
        {row.eligible_satellites.length > 3 && ` +${row.eligible_satellites.length - 3}`}</td>
      <td>
        <Chip tone={state.tone}>{state.label}</Chip>
        {certified && <Chip tone="cert" title="Сертификат невыполнимости">доказано</Chip>}
      </td>
    </tr>
  )
}
