// Shared presentation: the words the service's codes are shown as, the number
// formats, and the handful of blocks every panel is built from.
//
// The refusal codes matter more than they look. The criteria ask that the
// reason a command was refused be understandable to the operator, so every
// code the library can emit is translated here, and an unknown code is shown
// raw rather than swallowed — a missing translation must be visible.

import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { Verdict } from './api/types'

export const REASONS: Record<string, string> = {
  accepted: 'выполнено',
  idle: 'простой',
  no_admissible_work: 'нет допустимой работы',
  satellite_unavailable: 'аппарат недоступен',
  unknown_job: 'неизвестное задание',
  already_completed: 'задание уже выполнено',
  outside_job_window: 'вне окна выполнения',
  ineligible_satellite: 'аппарат не допущен к заданию',
  no_contact: 'нет связи на этом шаге',
  calibration_required: 'требуется калибровка',
  energy_reserve: 'упёрлись в резерв заряда',
  thermal_limit: 'температурный предел',
  unknown_action: 'неизвестная команда',
  duplicate_job_in_step: 'задание уже взято другим аппаратом',
  ground_capacity: 'занят лимит передач на шаг',
  taken_by_another_satellite: 'задание уже взято другим аппаратом',
}

export const reason = (code: string | null | undefined) =>
  code ? (REASONS[code] ?? code) : '—'

export const ACTIONS: Record<string, string> = {
  job: 'работа по заданию',
  calibrate: 'калибровка',
  idle: 'простой',
}

export const action = (code: string | null | undefined) =>
  code ? (ACTIONS[code] ?? code) : '—'

export const VERDICTS: Record<Verdict, { label: string; tone: 'crit' | 'warn' | 'good' | 'ser' | '' }> = {
  completed: { label: 'выполнено', tone: 'good' },
  impossible_by_data: { label: 'невозможно по данным', tone: 'ser' },
  refused_by_satellite: { label: 'не пустил аппарат', tone: 'crit' },
  outcompeted: { label: 'проиграло контакт', tone: 'warn' },
  missed_without_attempt: { label: 'срок вышел, попыток не было', tone: 'crit' },
  in_progress: { label: 'в работе', tone: '' },
  open: { label: 'ждёт своего окна', tone: '' },
}

export const CERTIFICATES: Record<string, string> = {
  contact_window_shorter_than_work: 'в окне меньше контактов, чем нужно работы',
  satellite_contacts_oversubscribed: 'группа заданий перекрывает все контакты интервала',
}

export const EVENT_KINDS: Record<string, string> = {
  add_jobs: 'новые задания',
  satellite_outage: 'недоступность аппаратов',
  close_downlink: 'отмена сеансов связи',
}

// --- numbers ---------------------------------------------------------------

const nf = new Intl.NumberFormat('ru-RU')
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export const num = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : nf.format(Math.round(value))
export const dec = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : nf1.format(value)
export const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : '$' + nf.format(Math.round(value))
export const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : nf1.format(value) + '%'
export const share = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0)

/** A step index as time of shift: steps are five minutes, the shift is a day.
 *  The last step reads 24:00 rather than 00:00 — the end of the shift, not its
 *  beginning. */
export function clock(step: number, stepSeconds = 300) {
  const total = step * stepSeconds
  const hours = Math.floor(total / 3600)
  const h = hours === 24 ? 24 : hours % 24
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export const signed = (value: number, digits = 0) =>
  (value > 0 ? '+' : value < 0 ? '−' : '') +
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Math.abs(value))

// --- blocks ----------------------------------------------------------------

export function Card({ title, note, right, children, className }: {
  title?: ReactNode; note?: ReactNode; right?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={'card' + (className ? ' ' + className : '')}>
      {(title || note || right) && (
        <header>
          <div>
            {title && <h3>{title}</h3>}
            {note && <p>{note}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

export function Tile({ label, value, unit, foot, tone }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; foot?: ReactNode
  tone?: 'up' | 'down' | 'flat'
}) {
  return (
    <div className="tile">
      <span className="k">{label}</span>
      <span className="v">{value}{unit && <small> {unit}</small>}</span>
      {foot && <span className={'d' + (tone ? ' ' + tone : '')}>{foot}</span>}
    </div>
  )
}

export function Chip({ tone, children, title }: {
  tone?: 'good' | 'warn' | 'crit' | 'ser' | 'cert'; children: ReactNode; title?: string
}) {
  return <span className={'chip' + (tone ? ' ' + tone : '')} title={title}>{children}</span>
}

export function Meter({ value, mark, tone }: { value: number; mark?: number; tone?: string }) {
  return (
    <div className="meter">
      <div className="bar">
        <i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }} />
        {mark !== undefined && <u style={{ left: `${mark}%` }} />}
      </div>
      <b>{Math.round(value)}%</b>
    </div>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>

export function Note({ children }: { children: ReactNode }) {
  return <div className="note">{children}</div>
}

export function Failure({ error, what }: { error: { message: string } | null; what: string }) {
  if (!error) return null
  return (
    <div className="note failure">
      <AlertTriangle size={16} aria-hidden />
      <span><b>{what}.</b> {error.message}</span>
    </div>
  )
}

export function Loading({ what }: { what: string }) {
  return <p className="empty" role="status">{what}…</p>
}

export function Legend({ items }: { items: { color: string; label: ReactNode }[] }) {
  return (
    <div className="legend">
      {items.map((item, i) => (
        <span key={i}><i style={{ background: item.color }} />{item.label}</span>
      ))}
    </div>
  )
}
