// Everything the panels compute from the compact shift grid.
//
// The grid arrives as one character per satellite-step, so the whole shift fits
// in memory and the cursor can move without asking the service anything. The
// figures below are sums of that same data, and the per-step progress series
// come from the service already attributed the way the library attributes them:
// summing one up to the cursor gives exactly what the service reports there.

import type {
  CaseEvent, Contacts, DownlinkPlan, Feasibility, Grid, RunInfo, SatelliteRow, SlotPrices, Summary,
} from './api/types'
import type { Tab } from './store'
import { EVENT_KINDS, dec, num, plural, steps as stepsWord } from './ui'

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

// --- what needs the operator now -------------------------------------------
//
// The console answered "what happened" and left "what do you need from me"
// unanswered. These rows are that answer, and every one of them is derived from
// responses the overview has already loaded — no new endpoint, no new request.
//
// The order is the price of the mistake, not the severity of the word: an
// obligation of priority three outranks revenue, and revenue outranks idle time.
// Ranks are explicit so that adding a source later cannot quietly reorder them.

export const ATTENTION_RANK = {
  obligation: 0,
  revenue: 1,
  idle: 2,
} as const

export interface AttentionRow {
  id: string
  /** Where the cursor lands. */
  step: number
  /** A state token, used for the left border and the step column. */
  tone: string
  rank: number
  title: string
  why: string
  /** The screen this row is an invitation to open. */
  cta: string
  tab: Tab
  job?: string
}

interface AttentionInput {
  run: RunInfo
  cursor: number
  grid?: Grid
  satellites?: SatelliteRow[]
  feasibility?: Feasibility
  plan?: DownlinkPlan | null
  prices?: SlotPrices | null
  events?: CaseEvent[]
}

/** The earliest downlink this satellite has been promised after `after`. */
function promisedAfter(plan: DownlinkPlan | null | undefined, satellite: string, after: number) {
  let best: { step: number; job: string } | null = null
  for (const [step, bySatellite] of Object.entries(plan?.assignments ?? {})) {
    const at = Number(step)
    if (at <= after) continue
    const job = bySatellite[satellite]
    if (!job) continue
    if (!best || at < best.step) best = { step: at, job }
  }
  return best
}

export function attention(input: AttentionInput): AttentionRow[] {
  const { run, grid, satellites, feasibility, plan, prices, events } = input
  const rows: AttentionRow[] = []
  const total = run.total_steps

  // Calibration that runs out before a transmission the shift has committed to.
  // The satellite would be refused at the very step it was counted on. A whole
  // constellation drifts out of calibration together, so this is one row about
  // the nearest case with a count of the rest: a list of twenty-six identical
  // lines is a wall, not an alert.
  const expiring = (satellites ?? [])
    .filter((sat) => sat.available)
    .map((sat) => {
      const left = Math.max(sat.calibration_valid_steps - sat.calibration_age_steps, 0)
      const expires = Math.min(run.step + left, total)
      return { sat, expires, promised: promisedAfter(plan, sat.satellite_id, expires) }
    })
    .filter((item) => item.promised !== null && item.expires - run.step <= 24)
    .sort((a, b) => a.expires - b.expires)
  const soonest = expiring[0]
  if (soonest && soonest.promised) {
    const others = expiring.length - 1
    rows.push({
      id: `calibration:${soonest.sat.satellite_id}`,
      step: soonest.expires,
      tone: 'var(--crit)',
      rank: ATTENTION_RANK.obligation,
      title: `${soonest.sat.satellite_id}: калибровка истекает раньше обещанной передачи`,
      why: `Срок калибровки выходит на шаге ${soonest.expires}, передача ${soonest.promised.job} `
        + `обещана на ${soonest.promised.step}. Калибровку нужно успеть поставить раньше — `
        + 'и проверить, что на неё хватит заряда.'
        + (others > 0
          ? ` В том же положении ещё ${others} ${plural(others, 'аппарат', 'аппарата', 'аппаратов')}.`
          : ''),
      cta: 'Аппараты',
      tab: 'sats',
    })
  }

  // An obligation of priority three that carries a certificate of impossibility.
  // It stays in the denominator of the official figures, so it is worth seeing
  // even though no plan could have taken it.
  const opening = feasibility?.at_open ?? feasibility
  const impossibleCritical = (opening?.impossible_jobs ?? [])
    .filter((item) => item.priority === 3 && item.job_id)
    .sort((a, b) => (a.window?.[1] ?? total) - (b.window?.[1] ?? total))
  // The one worth naming is the next deadline the shift will fail to meet, not
  // the first of the day — which, mid-shift, is already behind the cursor.
  const first = impossibleCritical.find((item) => (item.window?.[1] ?? total) >= input.cursor)
    ?? impossibleCritical[impossibleCritical.length - 1]
  if (first) {
    const deadline = first.window?.[1] ?? run.step
    const more = impossibleCritical.length - 1
    rows.push({
      id: `impossible:${first.job_id}`,
      step: Math.min(deadline, total),
      tone: 'var(--serious)',
      rank: ATTENTION_RANK.obligation,
      title: `${first.job_id} — обязательство П3 с сертификатом невыполнимости`,
      why: `В окне выполнения ${first.window?.[0]}–${first.window?.[1]} контактов ${first.contacts_in_window} `
        + `при потребности в ${stepsWord(first.work_required ?? 0)} работы. Сертификат выдан против данных: `
        + 'задание недостижимо при любом плане.'
        + (more > 0 ? ` Таких обязательств ещё ${more}.` : ''),
      cta: 'Разбор',
      tab: 'jobs',
      job: first.job_id,
    })
  }

  // Charge that went below the reserve: the shift bought work with margin it was
  // told to keep. The worst moment comes out of the grid the overview already has.
  if (run.summary.below_reserve_satellite_steps > 0 && grid?.soc) {
    let worst: { sid: string; step: number; soc: number } | null = null
    for (const [sid, series] of Object.entries(grid.soc)) {
      for (let step = 0; step < series.length; step++) {
        const soc = series[step]
        if (soc === null || soc === undefined) continue
        if (!worst || soc < worst.soc) worst = { sid, step, soc }
      }
    }
    if (worst) {
      rows.push({
        id: `reserve:${worst.sid}`,
        step: worst.step,
        tone: 'var(--warn)',
        rank: ATTENTION_RANK.revenue,
        title: `${worst.sid}: заряд опускался ниже резерва`,
        why: `Минимум смены — ${dec(worst.soc)} % на шаге ${worst.step}. `
          + `Ниже резерва проведено ${num(run.summary.below_reserve_satellite_steps)} `
          + `${plural(run.summary.below_reserve_satellite_steps, 'аппарато-шаг', 'аппарато-шага', 'аппарато-шагов')}: `
          + 'аппарат отказывает командам ровно там, где запас кончился.',
        cta: 'Аппараты',
        tab: 'sats',
      })
    }
  }

  // A contact left free on purpose. The one claim worth making here is that it
  // is a decision, not an oversight: the only bidder cannot finish inside its
  // window, and a half-done job is not paid for.
  const idleForCertified = prices?.totals.slots_idle_for_certified_job ?? 0
  if (idleForCertified > 0) {
    const row = (prices?.rows ?? []).find(
      (item) => item.basis === 'unused_contact' && item.price_ground === 'unreachable_by_window')
    if (row) {
      rows.push({
        id: `idle-slot:${row.step}`,
        step: row.step,
        tone: 'var(--s3)',
        rank: ATTENTION_RANK.idle,
        title: `Контакт ${row.step} оставлен свободным намеренно`,
        why: 'Единственный претендент физически не успевает закончить в своём окне, '
          + 'а частично выполненное задание не оплачивается. Занять слот — потратить работу впустую. '
          + `Таких контактов за смену ${num(idleForCertified)}.`,
        cta: 'Смена',
        tab: 'shift',
      })
    }
  }

  // New information, and the claim the case asks us to make visible: it moved
  // only the intent, never the log.
  const last = (events ?? []).slice().sort((a, b) => b.at_step - a.at_step)[0]
  if (last) {
    rows.push({
      id: `event:${last.id}`,
      step: Math.min(last.at_step, total),
      tone: 'var(--s1)',
      rank: ATTENTION_RANK.idle,
      title: `Приняты новые сведения: ${EVENT_KINDS[last.type] ?? last.type}`,
      why: 'Пересчитано только намерение справа от курсора. Исполненная история не изменилась — '
        + 'сравните половины полотна на этом шаге.',
      cta: 'Полотно',
      tab: 'canvas',
    })
  }

  // Six rows is a list an operator reads; a longer one is a screen they skip.
  return rows.sort((a, b) => a.rank - b.rank || a.step - b.step).slice(0, 6)
}
