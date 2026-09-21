// Charts drawn by hand in SVG.
//
// A shift is 288 steps, which is small enough to draw a rectangle per step and
// sharp enough to read a single step off the screen — which is the point, since
// every question in this case is asked about one step. The cursor is part of
// every chart: to its left the shift happened, to its right it did not.

import { useMemo } from 'react'
import type { StepLoad } from '../derive'
import { num } from '../ui'

const W = 288

export function OccupancyChart({ load, cursor, satellites, height = 108 }: {
  load: StepLoad[]; cursor: number; satellites: number; height?: number
}) {
  const bars = useMemo(() => load.map((slot, step) => {
    const stack = [
      { key: 'd', value: slot.downlink, fill: 'var(--s1)' },
      { key: 'r', value: slot.relay, fill: 'var(--s3)' },
      { key: 'c', value: slot.calibrate, fill: 'var(--s2)' },
      { key: 'x', value: slot.refused, fill: 'var(--crit)' },
    ]
    let base = 0
    return { step, parts: stack.filter((p) => p.value > 0).map((part) => {
      const y = base
      base += part.value
      return { ...part, y }
    }) }
  }), [load])

  const scale = Math.max(satellites, 1)
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none"
         role="img" aria-label="Занятость группировки по шагам смены">
      <rect x={0} y={0} width={W} height={height} fill="var(--inset)" />
      {[0.25, 0.5, 0.75].map((line) => (
        <line key={line} x1={0} x2={W} y1={height * line} y2={height * line}
              stroke="var(--grid)" strokeWidth={0.5} />
      ))}
      {bars.map((bar) => (
        <g key={bar.step} opacity={bar.step < cursor ? 1 : 0.22}>
          {bar.parts.map((part) => (
            <rect key={part.key} x={bar.step} width={1}
                  y={height - ((part.y + part.value) / scale) * height}
                  height={(part.value / scale) * height} fill={part.fill} />
          ))}
        </g>
      ))}
      <line x1={cursor} x2={cursor} y1={0} y2={height} stroke="var(--ink)" strokeWidth={0.7} />
    </svg>
  )
}

export interface BandCell {
  step: number
  supply: number
  used: number
  price: number
  ground: string | null
}

export function ContactBand({ cells, cursor, limit, onPick, height = 34 }: {
  cells: BandCell[]; cursor: number; limit: number
  onPick?: (step: number) => void; height?: number
}) {
  const maxPrice = Math.max(1, ...cells.map((cell) => cell.price))
  const top = height - 10
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none"
         role="img" aria-label="Окна наземной связи и цена слота по шагам"
         onClick={(event) => {
           if (!onPick) return
           const box = event.currentTarget.getBoundingClientRect()
           onPick(Math.floor(((event.clientX - box.left) / box.width) * W))
         }}
         style={onPick ? { cursor: 'crosshair' } : undefined}>
      <rect x={0} y={0} width={W} height={top} fill="var(--inset)" />
      {cells.map((cell) => {
        if (cell.supply === 0) return null
        const share = Math.min(cell.used / limit, 1)
        return (
          <g key={cell.step} opacity={cell.step < cursor ? 1 : 0.3}>
            <rect x={cell.step} y={2} width={1} height={top - 4} fill="var(--idle)" />
            {share > 0 && (
              <rect x={cell.step} y={2 + (top - 4) * (1 - share)} width={1}
                    height={(top - 4) * share} fill="var(--s1)" />
            )}
          </g>
        )
      })}
      {cells.map((cell) => cell.price > 0 && (
        <rect key={cell.step} x={cell.step} y={top} width={1} height={10}
              fill={cell.ground === 'unreachable_by_window' ? 'var(--serious)' : 'var(--crit)'}
              opacity={0.25 + 0.75 * (cell.price / maxPrice)} />
      ))}
      <line x1={cursor} x2={cursor} y1={0} y2={height} stroke="var(--ink)" strokeWidth={0.7} />
    </svg>
  )
}

/** The proof behind one job: its window against its satellite's real contacts.
 *
 *  Drawn around the window rather than across the whole shift — a job that
 *  lives for eight steps out of 288 is invisible at full scale, and this figure
 *  exists to be read, not to be decorative. The margin is stated on the axis so
 *  that the zoom cannot be mistaken for the window itself. */
export function WindowProof({ window: span, contacts, need, have, total, completedAt }: {
  window: [number, number]; contacts: [number, number][]
  need: number; have: number; total: number; completedAt?: number | null
}) {
  const height = 52
  const width = Math.max(span[1] - span[0], 1)
  const margin = Math.max(6, Math.round(width * 0.4))
  const lo = Math.max(0, span[0] - margin)
  const hi = Math.min(total, span[1] + margin)
  const scale = W / Math.max(hi - lo, 1)
  const x = (step: number) => (step - lo) * scale
  const visible = contacts
    .map(([from, to]) => [Math.max(from, lo), Math.min(to, hi)] as [number, number])
    .filter(([from, to]) => to > from)
  return (
    <div className="proof-figure">
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none"
           role="img" aria-label="Окно выполнения против расписания контактов">
        <rect x={0} y={4} width={W} height={14} fill="var(--inset)" />
        <rect x={x(span[0])} width={Math.max(x(span[1]) - x(span[0]), 1)} y={4} height={14}
              fill="color-mix(in srgb, var(--accent) 26%, transparent)"
              stroke="var(--accent)" strokeWidth={0.6} />
        <rect x={0} y={26} width={W} height={14} fill="var(--inset)" />
        {visible.map(([from, to], i) => (
          <rect key={i} x={x(from)} width={Math.max(x(to) - x(from), 1.5)} y={26} height={14}
                fill="var(--s1)" />
        ))}
        {completedAt != null && completedAt >= lo && completedAt <= hi && (
          <line x1={x(completedAt)} x2={x(completedAt)} y1={2} y2={height - 10}
                stroke="var(--good)" strokeWidth={1} />
        )}
        <text x={2} y={height - 1} fontSize={8} fill="var(--ink-3)" fontFamily="var(--mono)">{lo}</text>
        <text x={W - 2} y={height - 1} fontSize={8} fill="var(--ink-3)" fontFamily="var(--mono)"
              textAnchor="end">{hi}</text>
      </svg>
      <div className="readout">
        <span>окно <b>{span[0]}–{span[1]}</b></span>
        <span>контактов в окне <b>{have}</b></span>
        <span>нужно работы <b>{need}</b></span>
        {have < need && <span className="down"><b>не хватает {need - have}</b></span>}
      </div>
      <p className="tbl-note">
        Верхняя полоса — окно выполнения задания, нижняя — реальные контакты его аппарата.
        Показан отрезок смены {lo}–{hi} из {total} шагов.
      </p>
    </div>
  )
}

export function Bars({ rows, height = 8 }: {
  rows: { label: string; value: number; max: number; fill?: string; note?: string }[]
  height?: number
}) {
  return (
    <div className="bars">
      {rows.map((row) => (
        <div className="bars-row" key={row.label}>
          <span className="bars-label">{row.label}</span>
          <div className="bars-track" style={{ height }}>
            <i style={{ width: `${row.max > 0 ? (100 * row.value) / row.max : 0}%`,
                        background: row.fill ?? 'var(--s1)' }} />
          </div>
          <b>{row.note ?? num(row.value)}</b>
        </div>
      ))}
    </div>
  )
}

