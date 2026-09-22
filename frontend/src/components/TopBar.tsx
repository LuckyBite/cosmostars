import { useState } from 'react'
import { Download, GitBranch, LogOut, Moon, Sun } from 'lucide-react'
import { api, useRunMutation } from '../api/client'
import type { Goal, RunInfo } from '../api/types'
import { SCREEN_TITLES } from '../App'
import { useConsole } from '../store'
import { Chip, Failure } from '../ui'

// What is left in the header after time moved out: where you are, what shift
// you are looking at, what the shift is being optimised for, and the three
// actions that act on the shift as a whole rather than on a step of it.

const GOALS: { id: Goal; label: string }[] = [
  { id: 'priority', label: 'Приоритет' },
  { id: 'revenue', label: 'Выручка' },
]

export function TopBar({ run }: { run: RunInfo }) {
  const tab = useConsole((s) => s.tab)
  const openRun = useConsole((s) => s.openRun)
  const closeRun = useConsole((s) => s.closeRun)
  const setTab = useConsole((s) => s.setTab)
  const setCompare = useConsole((s) => s.setCompare)
  const [theme, setTheme] = useState<'dark' | 'light' | null>(null)

  const goal = useRunMutation((next: Goal) => api.setGoal(run.run_id, next), run.run_id)
  const fork = useRunMutation(() => api.fork(run.run_id), run.run_id)
  const busy = goal.isPending || fork.isPending

  // Forking used to drop the operator into a run that looked exactly like the
  // one they left — same numbers, no explanation. The branch is now opened on
  // the tree, already paired against its parent, so the thing that just
  // happened is visible and the next move is in front of them.
  const onFork = () =>
    fork.mutate(undefined, {
      onSuccess: (branch) => {
        const made = branch as RunInfo
        setCompare('left', run.run_id)
        setCompare('right', made.run_id)
        openRun(made.run_id)
        setTab('branches')
      },
    })

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
      <header className="head">
        <div className="head-title">
          <h1>{SCREEN_TITLES[tab]}</h1>
          <div className="head-ctx">
            <span className="mono">{run.scenario_key}</span>
            <span>·</span>
            <span className="mono">{run.planner} {run.planner_version}</span>
            {run.parent_id && (
              <Chip tone="good">Ветвь от {run.parent_id.slice(0, 6)} · шаг {run.forked_at_step}</Chip>
            )}
          </div>
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

        <div className="acts">
          <button className="btn" disabled={busy} onClick={onFork}
                  title="Отделить продолжение от этого шага и сравнить его с текущей сменой">
            <GitBranch size={13} aria-hidden /> Ветвь
          </button>
          <button className="btn" onClick={onExport} title="Выгрузка cosmo-B-ops-result-1.0">
            <Download size={13} aria-hidden /> Выгрузка
          </button>
          <button className="btn icon" onClick={flipTheme} aria-label="Сменить тему">
            {theme === 'light' ? <Moon size={13} /> : <Sun size={13} />}
          </button>
          <button className="btn icon" aria-label="Закрыть смену" title="К выбору смены"
                  onClick={closeRun}>
            <LogOut size={13} />
          </button>
        </div>
      </header>

      {(goal.error || fork.error) && (
        <div className="head-failures">
          <Failure error={goal.error} what="Цель не переключилась" />
          <Failure error={fork.error} what="Ветвь не создана" />
        </div>
      )}
    </>
  )
}
