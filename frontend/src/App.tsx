import { useEffect } from 'react'
import { useRun } from './api/client'
import { useConsole, type Tab } from './store'
import { StartScreen } from './components/StartScreen'
import { TopBar } from './components/TopBar'
import { Timeline } from './components/Timeline'
import { ShiftPanel } from './components/ShiftPanel'
import { CanvasPanel } from './components/CanvasPanel'
import { SatellitesPanel } from './components/SatellitesPanel'
import { JobsPanel } from './components/JobsPanel'
import { BranchesPanel } from './components/BranchesPanel'
import { VerifyPanel } from './components/VerifyPanel'
import { JuryPanel } from './components/JuryPanel'
import { Failure } from './ui'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'shift', label: 'Смена', hint: 'Итог, потолок выполнимости, сообщения' },
  { id: 'canvas', label: 'Полотно', hint: 'Факт и намерение на сетке аппараты × шаги' },
  { id: 'sats', label: 'Аппараты', hint: 'Заряд, температура, калибровка' },
  { id: 'jobs', label: 'Задания', hint: 'Разбор: почему не вышло' },
  { id: 'branches', label: 'Ветви', hint: 'Дерево смены и сравнение вариантов' },
  { id: 'verify', label: 'Проверка', hint: 'Пересчёт выгрузки выданной библиотекой' },
  { id: 'jury', label: 'Жюри', hint: 'Маршруты по критериям' },
]

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

  return (
    <>
      <TopBar run={run} />
      <Timeline run={run} />
      <nav className="tabs">
        <div className="wrap" role="tablist" aria-label="Экраны пульта">
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              title={item.hint}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>
      <main>
        <div className="wrap">
          <Failure error={error} what="Состояние смены не обновилось" />
          <section role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
            {tab === 'shift' && <ShiftPanel run={run} />}
            {tab === 'canvas' && <CanvasPanel run={run} />}
            {tab === 'sats' && <SatellitesPanel run={run} />}
            {tab === 'jobs' && <JobsPanel run={run} />}
            {tab === 'branches' && <BranchesPanel run={run} />}
            {tab === 'verify' && <VerifyPanel run={run} />}
            {tab === 'jury' && <JuryPanel run={run} />}
          </section>
        </div>
      </main>
    </>
  )
}
