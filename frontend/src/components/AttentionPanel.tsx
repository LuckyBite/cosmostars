import { useMemo } from 'react'
import { useDownlinkPlan, useEvents, useFeasibility, useGrid, useSatellites, useSlotPrices } from '../api/client'
import type { RunInfo } from '../api/types'
import { attention } from '../derive'
import { useConsole } from '../store'
import { Card, Empty } from '../ui'

// The console answered "what happened" and left "what do you need from me now"
// unanswered. This is that answer, ranked by the price of the mistake: an
// obligation of priority three above revenue, revenue above idle time.
//
// Nothing here asks the service for anything new — every row is derived in
// derive.ts from responses the overview has already loaded. A row is a single
// gesture: it puts the cursor on the step and opens the screen that explains it.

export function AttentionPanel({ run }: { run: RunInfo }) {
  const cursor = useConsole((s) => s.cursor)
  const jumpTo = useConsole((s) => s.jumpTo)

  const grid = useGrid(run.run_id)
  const satellites = useSatellites(run.run_id)
  const feasibility = useFeasibility(run.run_id)
  const plan = useDownlinkPlan(run.run_id)
  const prices = useSlotPrices(run.run_id)
  const events = useEvents(run.run_id)

  const rows = useMemo(() => attention({
    run,
    cursor,
    grid: grid.data,
    satellites: satellites.data?.items,
    feasibility: feasibility.data,
    plan: plan.data?.plan,
    prices: prices.data?.prices,
    events: events.data?.items,
  }), [run, cursor, grid.data, satellites.data, feasibility.data, plan.data, prices.data, events.data])

  return (
    <Card
      className="attn"
      title={<><i className="attn-dot" aria-hidden /> Требует внимания</>}
      note="Что́ на курсоре стоит денег или обязательства. Клик — курсор встаёт на шаг."
    >
      {rows.length === 0 ? (
        <Empty>На курсоре нет ничего, что стоило бы обязательства или денег.</Empty>
      ) : (
        <>
          <ul className="attn-list">
            {rows.map((row) => (
              <li key={row.id}>
                <button className="attn-row" style={{ ['--tone' as string]: row.tone }}
                        onClick={() => jumpTo(row.step, row.tab, row.job ?? undefined)}>
                  <span className="attn-at">шаг {row.step}</span>
                  <span className="attn-body">
                    <b>{row.title}</b>
                    <span>{row.why}</span>
                  </span>
                  <span className="attn-cta">{row.cta}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="tbl-note">
            Список ранжирован по цене ошибки: обязательство приоритета 3 выше выручки,
            выручка выше простоя.
          </p>
        </>
      )}
    </Card>
  )
}
