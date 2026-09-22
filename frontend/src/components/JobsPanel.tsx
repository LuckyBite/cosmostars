import { useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFeasibility, useJobs } from '../api/client'
import type { JobRow, JobState, RunInfo } from '../api/types'
import { useConsole } from '../store'
import { Card, Chip, Empty, Failure, Loading, Meter, num, usd, type Tone } from '../ui'
import { JobExplain } from './JobExplain'

const FILTERS: { id: JobState | 'all'; label: string }[] = [
  { id: 'missed', label: 'Просроченные' },
  { id: 'open', label: 'В работе' },
  { id: 'completed', label: 'Выполненные' },
  { id: 'pending', label: 'Ещё не открылись' },
  { id: 'all', label: 'Все' },
]

const STATES: Record<JobState, { label: string; tone: Tone }> = {
  completed: { label: 'Выполнено', tone: 'good' },
  missed: { label: 'Просрочено', tone: 'crit' },
  open: { label: 'В работе', tone: 's1' },
  pending: { label: 'Ждёт своего окна', tone: '' },
}

// The operator sorts to answer a question — the most expensive job that was
// missed, the tightest window, the satellite carrying the most work. Each
// column therefore sorts by the number the operator is actually reading in it,
// not by the string that happens to be printed.
type ColumnId = 'id' | 'kind' | 'priority' | 'value' | 'window' | 'progress' | 'sats' | 'state'

const COLUMNS: {
  id: ColumnId; label: string; width: number; num?: boolean
  by: (row: JobRow) => number | string
}[] = [
  { id: 'id', label: 'Задание', width: 108, by: (r) => r.job_id },
  { id: 'kind', label: 'Тип', width: 104, by: (r) => r.kind },
  { id: 'priority', label: 'Приоритет', width: 92, num: true, by: (r) => r.priority },
  { id: 'value', label: 'Цена', width: 80, num: true, by: (r) => r.value_usd },
  { id: 'window', label: 'Окно', width: 92, by: (r) => r.deadline_step },
  { id: 'progress', label: 'Прогресс', width: 124, by: (r) => r.progress_steps / r.work_steps },
  { id: 'sats', label: 'Исполнители', width: 128, by: (r) => r.eligible_satellites.length },
  { id: 'state', label: 'Исход', width: 208, by: (r) => STATES[r.state].label },
]

const MIN_COLUMN = 56

export function JobsPanel({ run }: { run: RunInfo }) {
  const [filter, setFilter] = useState<JobState | 'all'>('missed')
  const [kind, setKind] = useState<'all' | 'downlink' | 'relay'>('all')
  const [search, setSearch] = useState('')
  const [onlyCritical, setOnlyCritical] = useState(false)
  const [sort, setSort] = useState<{ by: ColumnId; dir: 1 | -1 } | null>(null)
  const [widths, setWidths] = useState<number[]>(() => COLUMNS.map((c) => c.width))
  const selectedJob = useConsole((s) => s.selectedJob)
  const selectJob = useConsole((s) => s.selectJob)

  // 5000 is the ceiling the service puts on this endpoint; asking for more is
  // refused outright. It covers every scenario whole except P04, where the
  // footnote below states plainly how many of the 8 120 are on screen.
  const jobs = useJobs(run.run_id, filter, 5000)
  const feas = useFeasibility(run.run_id)

  // Certificates are taken from the report as it stood when the shift opened:
  // a job the data forbids is forbidden whatever the planner did later.
  const certified = useMemo(
    () => new Set((feas.data?.impossible_jobs ?? []).map((item) => item.job_id)),
    [feas.data],
  )

  const rows = useMemo(() => {
    const needle = search.trim().toUpperCase()
    const list = (jobs.data?.items ?? []).filter((row) =>
      (kind === 'all' || row.kind === kind) &&
      (!onlyCritical || row.priority === 3) &&
      (!needle || row.job_id.includes(needle) || row.eligible_satellites.some((sid) => sid.includes(needle))))
    if (!sort) return list
    const column = COLUMNS.find((c) => c.id === sort.by)
    if (!column) return list
    // Sorted copy: the unsorted order is the service's own and worth keeping.
    return [...list].sort((a, b) => {
      const left = column.by(a)
      const right = column.by(b)
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sort.dir
      return String(left).localeCompare(String(right), 'ru') * sort.dir
    })
  }, [jobs.data, kind, onlyCritical, search, sort])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 14,
  })
  const visible = virtual.getVirtualItems()
  const padTop = visible.length ? visible[0].start : 0
  const padBottom = visible.length ? virtual.getTotalSize() - visible[visible.length - 1].end : 0

  const flipSort = (id: ColumnId) =>
    setSort((prev) => (prev?.by !== id ? { by: id, dir: 1 } : prev.dir === 1 ? { by: id, dir: -1 } : null))

  // Dragging a column edge is a pointer gesture on a table header, so the
  // starting width travels with the gesture rather than through state.
  const drag = useRef<{ index: number; from: number; at: number } | null>(null)
  const onResizeMove = useCallback((event: PointerEvent) => {
    const active = drag.current
    if (!active) return
    const next = Math.max(MIN_COLUMN, active.from + event.clientX - active.at)
    setWidths((prev) => prev.map((value, i) => (i === active.index ? next : value)))
  }, [])
  const onResizeEnd = useCallback(() => {
    drag.current = null
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
    document.body.classList.remove('col-resizing')
  }, [onResizeMove])
  const onResizeStart = (index: number) => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    drag.current = { index, from: widths[index], at: event.clientX }
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeEnd)
    document.body.classList.add('col-resizing')
  }

  const total = widths.reduce((sum, value) => sum + value, 0)

  return (
    <>
      <Failure error={jobs.error} what="Список заданий не загрузился" />
      <Split>
        <Card title="Задания смены"
              note="Строка — задание. Клик открывает разбор: почему оно вышло или не вышло, с доказательством, а не с общими словами. Заголовок колонки сортирует, его правый край тянет ширину.">
          <div className="filters">
            {FILTERS.map((item) => (
              <button key={item.id} className="pill" aria-pressed={filter === item.id}
                      onClick={() => setFilter(item.id)}>{item.label}</button>
            ))}
            <span className="sep" />
            {(['all', 'downlink', 'relay'] as const).map((item) => (
              <button key={item} className="pill" aria-pressed={kind === item}
                      onClick={() => setKind(item)}>
                {item === 'all' ? 'Любой тип' : item === 'downlink' ? 'Связь' : 'Ретрансляция'}
              </button>
            ))}
            <button className="pill" aria-pressed={onlyCritical}
                    onClick={() => setOnlyCritical((v) => !v)}>Только приоритет 3</button>
            <input type="search" placeholder="JOB-0015 или S03" value={search}
                   onChange={(e) => setSearch(e.target.value)} aria-label="Поиск по заданию или аппарату" />
            {sort && (
              <button className="pill" onClick={() => setSort(null)}
                      title="Вернуть порядок сервиса">Снять сортировку</button>
            )}
          </div>

          {jobs.isPending ? <Loading what="Задания" /> : rows.length === 0 ? (
            <Empty>Под фильтр ничего не попало.</Empty>
          ) : (
            <div className="scroll jobs-scroll" ref={scrollRef}>
              <table className="grid-table" style={{ width: total, tableLayout: 'fixed' }}>
                <colgroup>
                  {widths.map((width, index) => <col key={COLUMNS[index].id} style={{ width }} />)}
                </colgroup>
                <thead>
                  <tr>
                    {COLUMNS.map((column, index) => (
                      <th key={column.id} className={column.num ? 'num' : undefined}
                          aria-sort={sort?.by === column.id
                            ? (sort.dir === 1 ? 'ascending' : 'descending')
                            : 'none'}>
                        <button className="th-sort" onClick={() => flipSort(column.id)}
                                title={`Сортировать по «${column.label}»`}>
                          {column.label}
                          <s aria-hidden>{sort?.by === column.id ? (sort.dir === 1 ? '↑' : '↓') : ''}</s>
                        </button>
                        <span className="th-grip" onPointerDown={onResizeStart(index)}
                              role="separator" aria-orientation="vertical"
                              aria-label={`Ширина колонки «${column.label}»`} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {padTop > 0 && <tr aria-hidden style={{ height: padTop }}><td colSpan={8} /></tr>}
                  {visible.map((item) => {
                    const row = rows[item.index]
                    return (
                      <JobLine key={row.job_id} row={row} selected={row.job_id === selectedJob}
                               certified={certified.has(row.job_id)}
                               index={item.index} measure={virtual.measureElement}
                               onPick={() => selectJob(row.job_id)} />
                    )
                  })}
                  {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }}><td colSpan={8} /></tr>}
                </tbody>
              </table>
              <p className="tbl-note">
                Показано {num(rows.length)} из {num(jobs.data?.total ?? 0)} по фильтру
                «{FILTERS.find((item) => item.id === filter)?.label}».
                {certified.size > 0 && <> Пунктирная метка — сертификат невыполнимости
                  ({num(certified.size)} заданий).</>}
              </p>
            </div>
          )}
        </Card>

        <JobExplain run={run} />
      </Split>
    </>
  )
}

// The table and the breakdown compete for the same width, and which of them
// needs it changes with the question being asked. The operator moves the line.
const SPLIT_DEFAULT = 66

function Split({ children }: { children: [ReactChild, ReactChild] }) {
  // The table asks for more width than half: eight columns of it are the
  // operator's working surface, while the breakdown is a column of prose.
  const [left, setLeft] = useState(SPLIT_DEFAULT)
  const frame = useRef<HTMLDivElement>(null)

  const onDown = (event: React.PointerEvent) => {
    event.preventDefault()
    const move = (moved: PointerEvent) => {
      const box = frame.current?.getBoundingClientRect()
      if (!box || box.width === 0) return
      const ratio = (100 * (moved.clientX - box.left)) / box.width
      setLeft(Math.max(28, Math.min(78, ratio)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('col-resizing')
  }

  return (
    <div className="jobs-layout" ref={frame}
         style={{ ['--left' as string]: `${left}%` }}>
      {children[0]}
      <div className="split-grip" onPointerDown={onDown} role="separator"
           aria-orientation="vertical" aria-label="Ширина таблицы заданий"
           onDoubleClick={() => setLeft(SPLIT_DEFAULT)} title="Тянуть — ширина таблицы. Двойной клик — поровну." />
      {children[1]}
    </div>
  )
}

type ReactChild = React.ReactNode

function JobLine({ row, selected, certified, index, measure, onPick }: {
  row: JobRow; selected: boolean; certified: boolean
  index: number; measure: (node: Element | null) => void; onPick: () => void
}) {
  // A certificate is the one case where the list already knows the verdict and
  // not just the state: the data forbade this job, whatever the planner did.
  const state = certified && row.state === 'missed'
    ? { label: 'Невозможно по данным', tone: 'ser' as Tone }
    : STATES[row.state]
  return (
    <tr aria-selected={selected} onClick={onPick} data-index={index} ref={measure}>
      <td className="id">{row.job_id}</td>
      <td>{row.kind === 'downlink' ? 'Связь' : 'Ретрансляция'}</td>
      <td className="num">{row.priority === 3 ? <Chip tone="warn">3</Chip> : row.priority}</td>
      <td className="num">{usd(row.value_usd)}</td>
      <td className="id">{row.release_step}–{row.deadline_step}</td>
      <td><Meter value={(100 * row.progress_steps) / row.work_steps}
                 tone={row.state === 'completed' ? 'var(--good)' : undefined} /></td>
      <td className="id">{row.eligible_satellites.slice(0, 3).join(' ')}
        {row.eligible_satellites.length > 3 && ` +${row.eligible_satellites.length - 3}`}</td>
      <td>
        <Chip tone={state.tone}>{state.label}</Chip>
        {certified && <Chip tone="cert" title="Сертификат невыполнимости">Доказано</Chip>}
      </td>
    </tr>
  )
}
