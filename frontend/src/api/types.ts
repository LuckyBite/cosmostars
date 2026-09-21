// Shapes returned by the service, named the way the API names them.
// Kept by hand rather than generated: the surface is small, and a hand-written
// type is where a mismatch with the backend shows up first.

export type Goal = 'priority' | 'revenue'

export interface ScenarioBrief {
  key: string
  id: string
  title: string
  steps: number
  step_seconds: number
  duration_hours: number
  satellites: number
  jobs_total: number
  jobs_downlink: number
  jobs_relay: number
  jobs_by_priority: Record<string, number>
  work_steps_total: number
  value_total_usd: number
  known_outages: number
  downlink_parallel_limit: number
  source: 'bundled' | 'uploaded'
}

export interface Summary {
  steps_executed: number
  jobs_total: number
  jobs_completed: number
  jobs_due: number
  jobs_due_missed: number
  critical_jobs_due: number
  critical_jobs_completed_on_time: number
  revenue_usd: number
  blocked_command_count: number
  below_reserve_satellite_steps: number
  brownout_satellite_steps: number
  critical_soc_satellite_steps: number
  minimum_soc_pct: number
  terminal_soc_pct: Record<string, number>
  work_steps_in_missed_jobs: number
}

export interface RunInfo {
  run_id: string
  title: string
  scenario_key: string
  scenario_id: string
  goal: Goal
  planner: string
  planner_version: string
  parameters: Record<string, unknown>
  step: number
  total_steps: number
  finished: boolean
  created_at: string
  parent_id: string | null
  forked_at_step: number | null
  goal_switches: { step: number; goal: Goal }[]
  events_received: number
  summary: Summary
}

export interface CaseEvent {
  id: string
  at_step: number
  type: 'add_jobs' | 'satellite_outage' | 'close_downlink'
  satellite_ids?: string[]
  end_step?: number
  jobs?: unknown[]
}

export interface SatelliteRow {
  satellite_id: string
  capacity_wh: number
  energy_wh: number
  soc_pct: number
  temp_c: number
  calibration_age_steps: number
  calibration_valid_steps: number
  calibration_expired: boolean
  available: boolean
  downlink_now: boolean | null
  relay_now: boolean | null
  last_action: string | null
  last_reason: string | null
}

export type JobState = 'completed' | 'missed' | 'pending' | 'open'

export interface JobRow {
  job_id: string
  kind: 'downlink' | 'relay'
  priority: number
  value_usd: number
  release_step: number
  deadline_step: number
  work_steps: number
  remaining_steps: number
  progress_steps: number
  eligible_satellites: string[]
  completed_step: number | null
  state: JobState
}

export interface TraceRow {
  step: number
  satellite_id: string
  requested: { action: string; job_id?: string }
  executed: string
  reason: string
  energy_before_wh: number
  energy_after_wh: number
  temp_before_c: number
  temp_after_c: number
  solar_w: number
  heater_w: number
  load_w: number
  calibration_age_steps: number
  completed_job: string | null
  brownout: boolean
  below_reserve: boolean
}

export type ProgressSeries =
  'completed' | 'due' | 'missed' | 'critical_due' | 'critical_done' | 'revenue_usd'

export interface Grid {
  step: number
  total_steps: number
  satellites: string[]
  /** One character per satellite-step: d, r, c, x, '.' or ' ' for not executed. */
  actions: Record<string, string>
  soc: Record<string, (number | null)[]>
  /** Per-step increments of the official figures, attributed as summary() does. */
  progress: Record<ProgressSeries, number[]>
  legend: Record<string, string>
}

export interface Contacts {
  total_steps: number
  items: { satellite_id: string; downlink: [number, number][]; relay: [number, number][] }[]
  outages: { satellite_id: string; start_step: number; end_step: number }[]
}

export interface Certificate {
  certificate: string
  job_id?: string
  satellite_id: string
  priority?: number
  value_usd?: number
  window?: [number, number]
  contacts_in_window?: number
  work_required?: number
  basis?: string
  evaluated_at_step?: number
  interval?: [number, number]
  jobs?: string[]
  contacts_in_interval?: number
  shortfall?: number
}

export interface Feasibility {
  built_at_step: number
  /** The same report as it stood when the shift was opened: the whole-shift bound. */
  at_open?: Feasibility
  downlink_ceiling: {
    work_steps_demanded: number
    work_steps_schedulable: number
    jobs_open: number
    jobs_unreachable_by_window: number
  }
  impossible_jobs: Certificate[]
  oversubscribed_satellites: Certificate[]
  totals: {
    impossible_job_count: number
    impossible_critical_count: number
    impossible_value_usd: number
    satellites_with_group_shortfall: number
    group_shortfall_work_steps: number
  }
}

export interface DownlinkPlan {
  built_at_step: number
  selected_jobs: string[]
  unreachable: { job_id: string; reason: string; satellite_id: string; slots_available: number; work_remaining: number; deadline_step: number; priority: number; value_usd: number }[]
  displaced: { job_id: string; reason: string; satellite_id: string; priority: number; value_usd: number }[]
  forced: string[]
  assignments: Record<string, Record<string, string>>
}

export interface SlotPriceRow {
  step: number
  satellite_id: string
  job_id: string | null
  rivals: number
  rivals_unserved: number
  price_usd: number
  price_priority: number | null
  price_job_id: string | null
  basis: 'unused_contact' | 'best_unserved_rival' | 'every_rival_served'
  price_ground: 'unreachable_by_window' | 'lost_to_selection' | null
}

export interface SlotPrices {
  built_at_step: number
  rows: SlotPriceRow[]
  totals: {
    contact_slots: number
    slots_assigned: number
    slots_unused: number
    slots_priced: number
    slots_idle_for_certified_job: number
    price_max_usd: number
    price_mean_usd: number
  }
}

export type Verdict =
  | 'completed' | 'impossible_by_data' | 'refused_by_satellite'
  | 'outcompeted' | 'missed_without_attempt' | 'in_progress' | 'open'

export interface Explain {
  job_id: string
  at_step: number
  job: {
    kind: 'downlink' | 'relay'
    priority: number
    value_usd: number
    window: [number, number]
    work_steps: number
    remaining_steps: number
    progress_steps: number
    eligible_satellites: string[]
    completed_step: number | null
  }
  verdict: Verdict
  impossible: Certificate | null
  competition: {
    slots_in_window: number
    slots_free: number
    slots_taken: { step: number; satellite_id: string; taken_by: string; priority: number | null; value_usd: number | null }[]
    slots_taken_total: number
    selected: boolean
    counterfactual: null | {
      servable: boolean
      reason?: string
      jobs_dropped?: { job_id: string; priority: number; value_usd: number; work_steps: number }[]
      jobs_dropped_count?: number
      value_given_up_usd?: number
      critical_given_up?: number
      value_gained_usd?: number
      critical_gained?: number
    }
  } | null
  refusals: { rows: { step: number; satellite_id: string; reason: string; executed: string }[]; total: number; dominant_reason: string | null }
  progress: { rows: { step: number; satellite_id: string; reason: string; executed: string }[]; total: number }
  instead: {
    window: [number, number]
    satellite_steps_by_action: Record<string, number>
    idle_while_in_contact: { step: number; satellite_id: string; executed: string; reason: string }[]
    idle_while_in_contact_total: number
  }
}

export interface Series {
  satellite_id: string
  capacity_wh: number
  reserve_soc_pct: number
  critical_soc_pct: number
  points: { step: number; soc_pct: number; temp_c: number; executed: string; reason: string; solar_w: number; load_w: number }[]
}

export interface CompareSide {
  run_id: string
  title: string
  goal: Goal
  planner: string
  step: number
  summary: Summary
}

export interface CompareReport {
  goal: Goal
  left: CompareSide
  right: CompareSide
  metrics: {
    metric: string
    label: string
    better: 'больше' | 'меньше' | 'нейтрально'
    left: number
    right: number
    delta: number
    leader: string | null
  }[]
  comparability: {
    shared_origin: { parent_run_id: string; branch_step: number | null } | null
    warnings: string[]
    comparable: boolean
  }
  verdict: { winner: string | null; metric: string; delta: number; text: string }
}

export interface VerifyReport {
  verdict: 'reproduced' | 'diverged'
  schema_version: string
  run_metadata: unknown
  scenario: { id: string; hash_in_file: string; hash_recomputed: string; match: boolean }
  replay: { steps_executed_in_file: number; steps_executed_replayed: number; events_replayed: number; commands_replayed: number; match: boolean }
  summary: { match: boolean; fields_compared: number; mismatches: { field: string; in_file: unknown; replayed: unknown }[]; replayed: Summary }
  trace: { match: boolean; rows_in_file: number | null; rows_replayed: number; digest_in_file: string | null; digest_replayed: string; first_divergence: unknown }
  tolerance: number
  checked_by: string
  same_check_by_hand: string
}

export interface AuditReport {
  at_step: number
  verdict: 'consistent' | 'inconsistent'
  physics: {
    rows_checked: number
    match: boolean
    mismatch_count: number
    mismatches: { step: number; satellite_id: string; field: string; recomputed: number; in_log: number }[]
  }
  accounting: {
    recomputed: Record<string, number>
    match: boolean
    mismatches: { field: string; recomputed: number; in_summary: number }[]
    completion_step_mismatch_count: number
  }
  checked_by: string
  what_it_proves: string
}

export interface ServiceError {
  error: string
  message: string
  detail: Record<string, unknown>
}
