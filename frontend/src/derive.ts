// Everything the panels compute from the compact shift grid.
//
// The grid arrives as one character per satellite-step, so the whole shift fits
// in memory and the cursor can move without asking the service anything. The
// figures below are sums of that same data, and the per-step progress series
// come from the service already attributed the way the library attributes them:
// summing one up to the cursor gives exactly what the service reports there.

import type { Contacts, Grid, Summary, SlotPrices } from './api/types'

export interface StepLoad {
  downlink: number
  relay: number
  calibrate: number
  refused: number
  idle: number
}

export interface Derived {
  load: StepLoad[]
  /** Satellite-steps of open ground contact, per step: the supply side. */
  contactSupply: number[]
  satellites: number
}

const EMPTY: StepLoad = { downlink: 0, relay: 0, calibrate: 0, refused: 0, idle: 0 }

export function deriveLoad(grid: Grid | undefined, contacts: Contacts | undefined): Derived {
  if (!grid) return { load: [], contactSupply: [], satellites: 0 }
  const total = grid.total_steps
  const load: StepLoad[] = Array.from({ length: total }, () => ({ ...EMPTY }))
  for (const sid of grid.satellites) {
    const row = grid.actions[sid]
    for (let k = 0; k < total; k++) {
      const cell = row.charCodeAt(k)
      const slot = load[k]
      if (cell === 100) slot.downlink++          // d
      else if (cell === 114) slot.relay++        // r
      else if (cell === 99) slot.calibrate++     // c
      else if (cell === 120) slot.refused++      // x
      else if (cell === 46) slot.idle++          // .
    }
  }
  const contactSupply = new Array<number>(total).fill(0)
  for (const item of contacts?.items ?? []) {
    for (const [from, to] of item.downlink) {
      for (let k = from; k < Math.min(to, total); k++) contactSupply[k]++
    }
  }
  return { load, contactSupply, satellites: grid.satellites.length }
}

/** The official figures as of the cursor, summed from the service's own series. */
export function summaryAt(grid: Grid | undefined, cursor: number, fallback: Summary): Summary {
  if (!grid?.progress) return fallback
  const upto = Math.min(cursor, grid.total_steps)
  const sum = (name: keyof Grid['progress']) => {
    const series = grid.progress[name] ?? []
    let out = 0
    for (let k = 0; k <= upto && k < series.length; k++) out += series[k]
    return out
  }
  return {
    ...fallback,
    steps_executed: upto,
    jobs_completed: sum('completed'),
    jobs_due: sum('due'),
    jobs_due_missed: sum('missed'),
    critical_jobs_due: sum('critical_due'),
    critical_jobs_completed_on_time: sum('critical_done'),
    revenue_usd: Math.round(sum('revenue_usd') * 100) / 100,
  }
}

/** Slot prices keyed by `step:satellite`, for the contact band and the canvas. */
export function priceIndex(prices: SlotPrices | null | undefined) {
  const index = new Map<string, { price: number; ground: string | null; jobId: string | null; rival: string | null }>()
  for (const row of prices?.rows ?? []) {
    index.set(`${row.step}:${row.satellite_id}`, {
      price: row.price_usd, ground: row.price_ground,
      jobId: row.job_id, rival: row.price_job_id,
    })
  }
  return index
}

export const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))
