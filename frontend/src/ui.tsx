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

export type Tone = 'good' | 'warn' | 'crit' | 'ser' | 's1' | 'cert' | ''

export const REASONS: Record<string, string> = {
  accepted: 'Выполнено',
  idle: 'Простой',
  no_admissible_work: 'Нет допустимой работы',
  satellite_unavailable: 'Аппарат недоступен',
  unknown_job: 'Неизвестное задание',
  already_completed: 'Задание уже выполнено',
  outside_job_window: 'Вне окна выполнения',
  ineligible_satellite: 'Аппарат не допущен к заданию',
  no_contact: 'Нет связи на этом шаге',
  calibration_required: 'Требуется калибровка',
  energy_reserve: 'Упёрлись в резерв заряда',
  thermal_limit: 'Температурный предел',
  unknown_action: 'Неизвестная команда',
  duplicate_job_in_step: 'Задание уже взято другим аппаратом',
  ground_capacity: 'Занят лимит передач на шаг',
  taken_by_another_satellite: 'Задание уже взято другим аппаратом',
}

export const reason = (code: string | null | undefined) =>
  code ? (REASONS[code] ?? code) : '—'

export const ACTIONS: Record<string, string> = {
  job: 'Работа по заданию',
  calibrate: 'Калибровка',
  idle: 'Простой',
}

export const action = (code: string | null | undefined) =>
  code ? (ACTIONS[code] ?? code) : '—'

export const VERDICTS: Record<Verdict, { label: string; tone: Tone }> = {
  completed: { label: 'Выполнено', tone: 'good' },
  impossible_by_data: { label: 'Невозможно по данным', tone: 'ser' },
  group_shortfall: { label: 'Группе не хватает контактов', tone: 'ser' },
  refused_by_satellite: { label: 'Не пустил аппарат', tone: 'crit' },
  outcompeted: { label: 'Проиграло контакт', tone: 'warn' },
  resource_starved: { label: 'Аппаратам не хватило ресурса', tone: 'crit' },
  missed_without_attempt: { label: 'Срок вышел, попыток не было', tone: 'crit' },
  in_progress: { label: 'В работе', tone: 's1' },
  open: { label: 'Ждёт своего окна', tone: '' },
}

/** Why an eligible satellite in relay contact stayed idle on a step. */
export const IDLE_REASONS: Record<string, string> = {
  unavailable: 'Аппарат недоступен',
  too_late: 'К сроку уже не успеть',
  below_reserve: 'Заряд ниже резерва',
  calibration_expired: 'Калибровка истекла',
  other: 'Иные причины',
}

export const CERTIFICATES: Record<string, string> = {
  contact_window_shorter_than_work: 'В окне меньше контактов, чем нужно работы',
  satellite_contacts_oversubscribed: 'Группа заданий перекрывает все контакты интервала',
}

export const EVENT_KINDS: Record<string, string> = {
  add_jobs: 'Новые задания',
  satellite_outage: 'Недоступность аппаратов',
  close_downlink: 'Отмена сеансов связи',
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
  value === null || value === undefined ? '—' : nf1.format(value) + '\u00a0%'
export const share = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0)

/** A count agrees with its noun: 1 шаг, 2 шага, 5 шагов. Numbers in this
 *  interface are almost always next to a noun, so one helper beats forty. */
export function plural(count: number, one: string, few: string, many: string) {
  const rest = Math.abs(Math.round(count)) % 100
  if (rest > 10 && rest < 20) return many
  const last = rest % 10
  return last === 1 ? one : last >= 2 && last <= 4 ? few : many
}

export const steps = (count: number) => `${num(count)} ${plural(count, 'шаг', 'шага', 'шагов')}`
export const jobsWord = (count: number) => plural(count, 'задание', 'задания', 'заданий')

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
  tone?: Tone; children: ReactNode; title?: string
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
      <b style={tone ? { color: tone } : undefined}>{Math.round(value)}%</b>
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
