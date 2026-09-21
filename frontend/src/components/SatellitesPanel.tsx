import { useMemo } from 'react'
import type uPlot from 'uplot'
import { useDownlinkPlan, useGrid, useSatelliteTrace, useSatellites, useSeries } from '../api/client'
import type { RunInfo, SatelliteRow } from '../api/types'
import { useConsole } from '../store'
import { Card, Chip, Empty, Failure, Loading, Meter, action, dec, num, pct, reason } from '../ui'
import { Plot } from './Uplot'

export function SatellitesPanel({ run }: { run: RunInfo }) {
  const cursor = useConsole((s) => s.cursor)
  const selected = useConsole((s) => s.selectedSatellite)
  const selectSatellite = useConsole((s) => s.selectSatellite)
  const setCursor = useConsole((s) => s.setCursor)
  const sats = useSatellites(run.run_id)
  const plan = useDownlinkPlan(run.run_id)
  const grid = useGrid(run.run_id)

  // Risk order. A satellite whose calibration runs out before a transmission it
  // has already been promised is the one that will refuse a command at the exact
  // step it was counted on; after that, low charge; then the rest by margin.
  const rows = useMemo(() => {
    const promised = new Map<string, number>()
    for (const [step, bySatellite] of Object.entries(plan.data?.plan?.assignments ?? {})) {
      const at = Number(step)
      if (at <= run.step) continue
      for (const sid of Object.keys(bySatellite)) {
        const seen = promised.get(sid)
        if (seen === undefined || at < seen) promised.set(sid, at)
      }
    }
    const risk = (row: SatelliteRow) => {
      if (!row.available) return 0
      const expires = run.step + (row.calibration_valid_steps - row.calibration_age_steps)
      const next = promised.get(row.satellite_id)
      if (next !== undefined && expires < next) return 1
      if (row.soc_pct < 30) return 2
      if (row.calibration_expired) return 3
      return 4
    }
    return (sats.data?.items ?? [])
      .map((row) => ({
        row,
        rank: risk(row),
        promised: promised.get(row.satellite_id) ?? null,
        doing: grid.data?.actions[row.satellite_id]?.[Math.max(run.step - 1, 0)] ?? ' ',
      }))
      .sort((a, b) => a.rank - b.rank || a.row.soc_pct - b.row.soc_pct)
  }, [sats.data, plan.data, grid.data, run.step])

  const current = selected ?? rows[0]?.row.satellite_id ?? null
  const series = useSeries(run.run_id, current)
  const log = useSatelliteTrace(run.run_id, current)

  const plots = useMemo(() => {
    const points = series.data?.points ?? []
    const steps = points.map((point) => point.step)
    const soc = points.map((point) => point.soc_pct)
    const temp = points.map((point) => point.temp_c)
    return {
      soc: [steps, soc] as uPlot.AlignedData,
      temp: [steps, temp] as uPlot.AlignedData,
    }
  }, [series.data])

  const reserve = series.data?.reserve_soc_pct ?? 0
  const critical = series.data?.critical_soc_pct ?? 0

  return (
    <>
      <Failure error={sats.error} what="Состояния аппаратов не загрузились" />
      <div className="two">
        <Card title={`Состояние группировки на шаге ${run.step}`}
              note="Заряд, температура и срок калибровки. Аппараты отсортированы по риску: сверху те, у кого запас кончается раньше обещанной передачи. Загрузка — доля исполненных шагов, отданных заданиям.">
          {sats.isPending ? <Loading what="Аппараты" /> : (
            <div className="scroll sats-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Аппарат</th><th>Заряд</th><th className="num">Темп., °C</th>
                    <th className="num">Калибровка</th><th className="num">Загрузка</th>
                    <th>Сейчас</th>
                    <th>Последнее действие</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ row, promised, doing }) => (
                    <tr key={row.satellite_id} aria-selected={row.satellite_id === current}
                        onClick={() => selectSatellite(row.satellite_id)}>
                      <td className="id">
                        {row.satellite_id}
                        {!row.available && <Chip tone="crit">Недоступен</Chip>}
                      </td>
                      <td>
                        <Meter value={row.soc_pct} mark={reserve}
                               tone={row.soc_pct < critical ? 'var(--crit)'
                                 : row.soc_pct < reserve ? 'var(--warn)' : undefined} />
                      </td>
                      <td className="num">{dec(row.temp_c)}</td>
                      <Calibration row={row} promised={promised} at={run.step} />
                      <td className="num"
                          title={`работа ${row.job_steps} · калибровка ${row.calibrate_steps} · простой ${row.idle_steps} из ${row.steps_executed} шагов`}>
                        {row.utilization_pct === null ? '—' : pct(row.utilization_pct)}
                      </td>
                      <td><Channel available={row.available} code={doing} /></td>
                      <td>
                        {action(row.last_action)}
                        {row.last_reason && row.last_reason !== 'accepted' && row.last_reason !== 'idle' && (
                          <Chip tone="crit">{reason(row.last_reason)}</Chip>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={current ? `${current} · заряд и температура` : 'Аппарат не выбран'}
              note="Две шкалы — две картинки: у заряда свой предел, у температуры свой. Вертикальная линия — курсор смены.">
          {!current || series.isPending ? <Loading what="Ряды" /> : (
            <div className="mini">
              <div>
                <h4>Заряд, % ёмкости</h4>
                <Plot
                  data={plots.soc}
                  mark={cursor}
                  options={{
                    height: 150,
                    scales: { x: { time: false }, y: { range: [0, 100] } },
                    legend: { show: false },
                    cursor: { y: false },
                    axes: [
                      { stroke: 'var(--ink-3)', grid: { stroke: 'var(--grid)', width: 0.5 } },
                      { stroke: 'var(--ink-3)', grid: { stroke: 'var(--grid)', width: 0.5 } },
                    ],
                    series: [
                      {},
                      { stroke: 'var(--s1)', width: 1.4, fill: 'color-mix(in srgb, var(--s1) 18%, transparent)' },
                    ],
                    hooks: {
                      draw: [(self) => {
                        const context = self.ctx
                        for (const [level, color] of [[reserve, 'var(--warn)'], [critical, 'var(--crit)']] as const) {
                          const y = self.valToPos(level, 'y', true)
                          context.save()
                          context.strokeStyle = color
                          context.setLineDash([3, 3])
                          context.beginPath()
                          context.moveTo(self.bbox.left, y)
                          context.lineTo(self.bbox.left + self.bbox.width, y)
                          context.stroke()
                          context.restore()
                        }
                      }],
                    },
                  }}
                />
                <p className="tbl-note">
                  Пунктир — резерв {pct(reserve)} и критический уровень {pct(critical)}.
                  Ниже резерва модель команды не пропускает.
                </p>
              </div>
              <div>
                <h4>Температура, °C</h4>
                <Plot data={plots.temp} mark={cursor} options={{
                  height: 130,
                  scales: { x: { time: false } },
                  legend: { show: false },
                  cursor: { y: false },
                  axes: [
                    { stroke: 'var(--ink-3)', grid: { stroke: 'var(--grid)', width: 0.5 } },
                    { stroke: 'var(--ink-3)', grid: { stroke: 'var(--grid)', width: 0.5 } },
                  ],
                  series: [{}, { stroke: 'var(--s2)', width: 1.4 }],
                }} />
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title={current ? `Журнал ${current}` : 'Журнал'}
            note="Что было запрошено, что исполнено и почему — строки модели, без нашей интерпретации. Показаны шаги вокруг курсора.">
        {!current || log.isPending ? <Loading what="Журнал" /> : (
          <LogTable rows={log.data?.items ?? []} cursor={cursor} onPick={setCursor} />
        )}
      </Card>
    </>
  )
}

function LogTable({ rows, cursor, onPick }: {
  rows: { step: number; requested: { action: string; job_id?: string }; executed: string
          reason: string; energy_after_wh: number; temp_after_c: number
          completed_job: string | null; below_reserve: boolean }[]
  cursor: number; onPick: (step: number) => void
}) {
  const around = rows.filter((row) => Math.abs(row.step - cursor) <= 14)
  if (!around.length) return <Empty>На этих шагах записей нет: смена сюда ещё не дошла.</Empty>
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Шаг</th><th>Запрошено</th><th>Исполнено</th><th>Причина</th>
              <th className="num">Заряд, Вт·ч</th><th className="num">Темп.</th><th>Завершено</th></tr>
        </thead>
        <tbody>
          {around.map((row) => (
            <tr key={row.step} aria-selected={row.step === cursor} onClick={() => onPick(row.step)}>
              <td className="num">{row.step}</td>
              <td className="id">{row.requested.job_id ?? action(row.requested.action)}</td>
              <td>{action(row.executed)}</td>
              <td>
                {reason(row.reason)}
                {row.below_reserve && <Chip tone="warn">Ниже резерва</Chip>}
              </td>
              <td className="num">{dec(row.energy_after_wh)}</td>
              <td className="num">{dec(row.temp_after_c)}</td>
              <td className="id">{row.completed_job ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tbl-note">Показаны {num(around.length)} шагов вокруг курсора.</p>
    </div>
  )
}

/** How long the calibration has left, and whether that is long enough. */
function Calibration({ row, promised, at }: {
  row: SatelliteRow; promised: number | null; at: number
}) {
  const left = row.calibration_valid_steps - row.calibration_age_steps
  const short = promised !== null && at + left < promised
  const tone = row.calibration_expired || short ? 'var(--crit)'
    : left <= 12 ? 'var(--warn)' : 'var(--ink-2)'
  return (
    <td className="num" style={{ color: tone }}
        title={promised !== null
          ? `Ближайшая обещанная передача — шаг ${promised}`
          : 'Передач этому аппарату не обещано'}>
      {row.calibration_expired ? 'Истекла' : `Через ${left}`}
      {short && !row.calibration_expired && <Chip tone="crit">Раньше передачи</Chip>}
    </td>
  )
}

/** What the satellite is doing on the last executed step, in its channel colour.
 *  The letter is the grid's own: d, r, c, x or a dot for idle. */
const CHANNELS: Record<string, [string, string]> = {
  d: ['Связь', 'var(--s1)'],
  r: ['Ретрансляция', 'var(--s3)'],
  c: ['Калибровка', 'var(--s2)'],
  x: ['Команда отклонена', 'var(--crit)'],
  '.': ['Простой', 'var(--idle)'],
}

function Channel({ available, code }: { available: boolean; code: string }) {
  const [label, tone] = !available ? ['Недоступен', 'var(--off)']
    : CHANNELS[code] ?? ['Не исполнено', 'var(--idle)']
  return (
    <span className="channel">
      <i style={{ background: tone }} />{label}
    </span>
  )
}
