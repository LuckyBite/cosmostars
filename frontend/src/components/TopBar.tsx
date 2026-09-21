import { useState } from 'react'
import { ChevronRight, Download, GitBranch, LogOut, Moon, SkipForward, Sun } from 'lucide-react'
import { api, useRunMutation } from '../api/client'
import type { Goal, RunInfo } from '../api/types'
import { useConsole } from '../store'
import { Chip, Failure, clock } from '../ui'

const GOALS: { id: Goal; label: string }[] = [
  { id: 'priority', label: 'приоритет' },
  { id: 'revenue', label: 'выручка' },
]

export function TopBar({ run }: { run: RunInfo }) {
  const openRun = useConsole((s) => s.openRun)
  const closeRun = useConsole((s) => s.closeRun)
  const pause = useConsole((s) => s.pause)
  const [target, setTarget] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light' | null>(null)

  const advance = useRunMutation(
    (body: { steps?: number; to_step?: number }) => api.advance(run.run_id, body), run.run_id)
  const goal = useRunMutation((next: Goal) => api.setGoal(run.run_id, next), run.run_id)
  const fork = useRunMutation(() => api.fork(run.run_id), run.run_id)

  const busy = advance.isPending || goal.isPending || fork.isPending
  const step = (body: { steps?: number; to_step?: number }) => { pause(); advance.mutate(body) }

  const onFork = () =>
    fork.mutate(undefined, { onSuccess: (branch) => openRun((branch as RunInfo).run_id) })

  const onExport = async () => {
    const result = await api.result(run.run_id)
    const blob = new Blob([JSON.stringify(result)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${run.scenario_key}-${run.goal}-${run.run_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const flipTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    setTheme(next)
  }

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <b>Пульт наземной смены</b>
            <span>
              {run.scenario_key} · {run.planner} {run.planner_version}
              {run.parent_id && <Chip tone="good">ветвь от {run.parent_id.slice(0, 6)} · шаг {run.forked_at_step}</Chip>}
            </span>
          </div>

          <div className="field">
            <label id="goal-lbl">Цель управления</label>
            <div className="seg" role="group" aria-labelledby="goal-lbl">
              {GOALS.map((item) => (
                <button key={item.id} aria-pressed={run.goal === item.id} disabled={busy}
                        onClick={() => goal.mutate(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="clock">
            <b>{clock(run.step)}</b>
            <i>шаг {run.step} из {run.total_steps}</i>
          </div>

          <div className="acts">
            <button className="btn" disabled={busy || run.finished} onClick={() => step({ steps: 1 })}>
              <ChevronRight size={14} aria-hidden /> шаг
            </button>
            <button className="btn" disabled={busy || run.finished} onClick={() => step({ steps: 12 })}>
              +час
            </button>
            <form className="to-step" onSubmit={(e) => {
              e.preventDefault()
              const value = Number(target)
              if (Number.isFinite(value)) step({ to_step: Math.trunc(value) })
            }}>
              <input inputMode="numeric" placeholder="до шага" value={target} aria-label="Остановиться перед шагом"
                     onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} />
              <button className="btn" type="submit" disabled={busy || !target}>
                <SkipForward size={14} aria-hidden />
              </button>
            </form>
            <button className="btn primary" disabled={busy || run.finished}
                    onClick={() => step({ to_step: run.total_steps })}>
              рассчитать смену
            </button>
            <button className="btn" disabled={busy} onClick={onFork} title="Продолжение из этого же состояния">
              <GitBranch size={14} aria-hidden /> ветвь
            </button>
            <button className="btn" onClick={onExport} title="cosmo-B-ops-result-1.0">
              <Download size={14} aria-hidden /> выгрузка
            </button>
            <button className="btn icon" onClick={flipTheme} aria-label="Сменить тему">
              {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
            </button>
            <button className="btn icon" aria-label="Закрыть смену" title="К выбору смены"
                    onClick={closeRun}>
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>
      <div className="wrap">
        <Failure error={advance.error} what="Шаг не выполнен" />
        <Failure error={goal.error} what="Цель не переключилась" />
        <Failure error={fork.error} what="Ветвь не создана" />
      </div>
    </>
  )
}
