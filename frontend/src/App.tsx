import { Fragment, useEffect } from 'react'
import {
  GitBranch, Grid3x3, LayoutDashboard, List, Satellite, SquareCheck, Zap, type LucideIcon,
} from 'lucide-react'
import { useRun } from './api/client'
import { useConsole, type Tab } from './store'
import { StartScreen } from './components/StartScreen'
import { Mark } from './components/Mark'
import { TopBar } from './components/TopBar'
import { Transport } from './components/Transport'
import { ShiftPanel } from './components/ShiftPanel'
import { CanvasPanel } from './components/CanvasPanel'
import { SatellitesPanel } from './components/SatellitesPanel'
import { JobsPanel } from './components/JobsPanel'
import { BranchesPanel } from './components/BranchesPanel'
import { VerifyPanel } from './components/VerifyPanel'
import { JuryPanel } from './components/JuryPanel'
import { Failure, num } from './ui'

// Seven equal tabs said all seven screens were the same kind of thing. They are
// not: four are the shift as it runs, three are the argument about it afterwards.
// The rail says so, and the time controls left the screens entirely — the cursor
// is global state, so it lives in the transport pinned to the bottom.

interface Item { id: Tab; label: string; hint: string; icon: LucideIcon }

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Смена',
    items: [
      { id: 'shift', label: 'Смена', hint: 'Итог на курсоре и узкие места', icon: LayoutDashboard },
      { id: 'canvas', label: 'Полотно', hint: 'Факт и намерение на сетке', icon: Grid3x3 },
      { id: 'sats', label: 'Аппараты', hint: 'Заряд, температура, калибровка', icon: Satellite },
      { id: 'jobs', label: 'Задания', hint: 'Разбор: почему не вышло', icon: List },
    ],
  },
  {
    title: 'Разбор',
    items: [
      { id: 'branches', label: 'Ветви', hint: 'Сравнение решений', icon: GitBranch },
      { id: 'verify', label: 'Проверка', hint: 'Независимый пересчёт', icon: SquareCheck },
      { id: 'show', label: 'Показ', hint: 'Маршруты по критериям', icon: Zap },
    ],
  },
]

export const SCREEN_TITLES: Record<Tab, string> = {
  shift: 'Смена — итог на курсоре',
  canvas: 'Полотно — факт и намерение',
  sats: 'Аппараты — ресурс и риск',
  jobs: 'Задания — почему не вышло',
  branches: 'Ветви — сравнение решений',
  verify: 'Проверка — независимый пересчёт',
  show: 'Показ — маршруты по критериям',
}

export function App() {
  const runId = useConsole((s) => s.runId)
  const tab = useConsole((s) => s.tab)
  const setTab = useConsole((s) => s.setTab)
  const syncFrontier = useConsole((s) => s.syncFrontier)
  const { data: run, error } = useRun(runId)

  // The service owns the executed frontier; the store only mirrors it.
  useEffect(() => {
    if (run) syncFrontier(run.step)
  }, [run?.step, run?.run_id, syncFrontier, run])

  if (!runId || !run) {
    return (
      <>
        <Failure error={error} what="Смена не открылась" />
        <StartScreen />
      </>
    )
  }

  const missed = run.summary.jobs_due_missed

  return (
    <div className="shell">
      <nav className="rail" aria-label="Экраны пульта">
        <div className="rail-brand">
          <Mark size={22} />
          <div>
            <b>Пульт смены</b>
            <span>{run.scenario_key}</span>
          </div>
        </div>

        {GROUPS.map((group, groupIndex) => (
          <Fragment key={group.title}>
            <div className={'rail-group' + (groupIndex > 0 ? ' next' : '')}>{group.title}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className="rail-item"
                title={item.hint}
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => setTab(item.id)}
              >
                <item.icon size={16} aria-hidden />
                <span>{item.label}</span>
                {item.id === 'jobs' && missed > 0 && (
                  <span className="rail-badge" title={`Просрочено заданий: ${num(missed)}`}>
                    {num(missed)}
                  </span>
                )}
              </button>
            ))}
          </Fragment>
        ))}

        <p className="rail-foot">Шаг — 5 минут.<br />Смена — {run.total_steps} шагов.</p>
      </nav>

      <div className="column">
        <TopBar run={run} />
        <main className="screen">
          <Failure error={error} what="Состояние смены не обновилось" />
          {tab === 'shift' && <ShiftPanel run={run} />}
          {tab === 'canvas' && <CanvasPanel run={run} />}
          {tab === 'sats' && <SatellitesPanel run={run} />}
          {tab === 'jobs' && <JobsPanel run={run} />}
          {tab === 'branches' && <BranchesPanel run={run} />}
          {tab === 'verify' && <VerifyPanel run={run} />}
          {tab === 'show' && <JuryPanel run={run} />}
        </main>
      </div>

      <Transport run={run} />
    </div>
  )
}

