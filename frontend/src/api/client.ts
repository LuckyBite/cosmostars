// One place that talks to the service.
//
// Two rules hold everywhere below. A refused request carries the service's own
// explanation, and that text reaches the operator unchanged — the interface
// never invents a reason. And nothing here caches across runs: a branch is a
// different shift, so its views are keyed by run id.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type {
  AuditReport, CaseEvent, CompareReport, Contacts, DownlinkPlan, Explain, Feasibility, Goal, Grid,
  JobRow, JobState, RunInfo, SatelliteRow, ScenarioBrief, Series, SlotPrices, TraceRow,
  VerifyReport,
} from './types'

const BASE = (import.meta.env.VITE_API_BASE ?? '') + '/api'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    let detail: Record<string, unknown> = {}
    try {
      const body = await response.json()
      // The service answers with {error, message, detail}; FastAPI's own
      // validation answers with {detail}. Both end up as one sentence.
      message = body.message ?? (typeof body.detail === 'string' ? body.detail : message)
      detail = body.detail ?? {}
    } catch {
      /* a non-JSON failure keeps its status line */
    }
    throw new ApiError(response.status, message, detail)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  scenarios: () => request<{ items: ScenarioBrief[] }>('/scenarios'),
  planners: () => request<{ goals: Goal[]; planners: { name: string; version: string }[] }>('/planners'),
  uploadScenario: (key: string, scenario: unknown) =>
    post<ScenarioBrief>('/scenarios', { key, scenario }),
  runs: () => request<{ items: RunInfo[] }>('/runs'),
  run: (id: string) => request<RunInfo>(`/runs/${id}`),
  createRun: (body: { scenario_key: string; goal: Goal; planner: string; title?: string }) =>
    post<RunInfo>('/runs', body),
  advance: (id: string, body: { steps?: number; to_step?: number }) =>
    post<RunInfo & { executed_steps: number }>(`/runs/${id}/advance`, body),
  event: (id: string, event: unknown) => post<RunInfo & { accepted: CaseEvent }>(`/runs/${id}/events`, { event }),
  outage: (id: string, body: { satellite_ids: string[]; end_step: number }) =>
    post<RunInfo>(`/runs/${id}/events/outage`, body),
  closeDownlink: (id: string, body: { satellite_ids: string[]; end_step: number }) =>
    post<RunInfo>(`/runs/${id}/events/close-downlink`, body),
  setGoal: (id: string, goal: Goal) => post<RunInfo>(`/runs/${id}/goal`, { goal }),
  fork: (id: string, title?: string) => post<RunInfo>(`/runs/${id}/fork`, { title }),
  events: (id: string) => request<{ items: CaseEvent[] }>(`/runs/${id}/events`),
  contacts: (id: string) => request<Contacts>(`/runs/${id}/contacts`),
  grid: (id: string) => request<Grid>(`/runs/${id}/grid`),
  audit: (id: string) => request<AuditReport>(`/runs/${id}/audit`),
  satellites: (id: string) => request<{ items: SatelliteRow[] }>(`/runs/${id}/satellites`),
  jobs: (id: string, params: { status?: JobState | 'all'; limit?: number; offset?: number }) => {
    const query = new URLSearchParams({
      status: params.status ?? 'all',
      limit: String(params.limit ?? 200),
      offset: String(params.offset ?? 0),
    })
    return request<{ total: number; offset: number; limit: number; items: JobRow[] }>(`/runs/${id}/jobs?${query}`)
  },
  trace: (id: string, params: { from_step?: number; to_step?: number; satellite_id?: string; limit?: number }) => {
    const query = new URLSearchParams({ limit: String(params.limit ?? 2000) })
    if (params.from_step !== undefined) query.set('from_step', String(params.from_step))
    if (params.to_step !== undefined) query.set('to_step', String(params.to_step))
    if (params.satellite_id) query.set('satellite_id', params.satellite_id)
    return request<{ total: number; limit: number; items: TraceRow[] }>(`/runs/${id}/trace?${query}`)
  },
  series: (id: string, satellite: string) => request<Series>(`/runs/${id}/series/${satellite}`),
  feasibility: (id: string) => request<Feasibility>(`/runs/${id}/feasibility`),
  downlinkPlan: (id: string) => request<{ plan: DownlinkPlan | null }>(`/runs/${id}/downlink-plan`),
  slotPrices: (id: string) => request<{ prices: SlotPrices | null }>(`/runs/${id}/slot-prices`),
  explain: (id: string, jobId: string) => request<Explain>(`/runs/${id}/jobs/${jobId}/explain`),
  result: (id: string) => request<Record<string, unknown>>(`/runs/${id}/result`),
  verifyRun: (id: string) => post<VerifyReport>(`/runs/${id}/verify`),
  verifyExport: (result: unknown) => post<VerifyReport>('/verify', { result }),
  compare: (left: string, right: string) =>
    request<CompareReport>(`/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
}

// --- queries ---------------------------------------------------------------
// Views of a run are invalidated together, because one step changes all of
// them. `runKey` is what every mutation below invalidates.

export const runKey = (id: string | null) => ['run', id] as const

type Opts<T> = Partial<UseQueryOptions<T, ApiError>>

function runQuery<T>(id: string | null, part: string, fn: (id: string) => Promise<T>, opts?: Opts<T>) {
  return useQuery<T, ApiError>({
    queryKey: [...runKey(id), part],
    queryFn: () => fn(id as string),
    enabled: !!id && (opts?.enabled ?? true),
    ...opts,
  })
}

export const useScenarios = () =>
  useQuery({ queryKey: ['scenarios'], queryFn: api.scenarios, staleTime: Infinity })

export const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: api.runs })

export const useRun = (id: string | null) => runQuery(id, 'info', api.run)
export const useEvents = (id: string | null) => runQuery(id, 'events', api.events)
export const useGrid = (id: string | null) => runQuery(id, 'grid', api.grid)
export const useAudit = (id: string | null) => runQuery(id, 'audit', api.audit)
export const useSatellites = (id: string | null) => runQuery(id, 'satellites', api.satellites)
export const useFeasibility = (id: string | null) => runQuery(id, 'feasibility', api.feasibility)
export const useDownlinkPlan = (id: string | null) => runQuery(id, 'downlink-plan', api.downlinkPlan)
export const useSlotPrices = (id: string | null) => runQuery(id, 'slot-prices', api.slotPrices)

// Contact windows and outages only change when a message arrives, and a message
// invalidates the whole run anyway, so this one may sit in cache.
export const useContacts = (id: string | null) =>
  runQuery(id, 'contacts', api.contacts, { staleTime: Infinity })

export const useJobs = (id: string | null, status: JobState | 'all', limit = 400) =>
  useQuery<{ total: number; offset: number; limit: number; items: JobRow[] }, ApiError>({
    queryKey: [...runKey(id), 'jobs', status, limit],
    queryFn: () => api.jobs(id as string, { status, limit }),
    enabled: !!id,
  })

/** The log of one satellite for the whole shift: 288 rows, safe to hold. */
export const useSatelliteTrace = (id: string | null, satellite: string | null) =>
  useQuery<{ total: number; limit: number; items: TraceRow[] }, ApiError>({
    queryKey: [...runKey(id), 'trace', satellite],
    queryFn: () => api.trace(id as string, { satellite_id: satellite as string, limit: 20000 }),
    enabled: !!id && !!satellite,
  })

export const useSeries = (id: string | null, satellite: string | null) =>
  useQuery<Series, ApiError>({
    queryKey: [...runKey(id), 'series', satellite],
    queryFn: () => api.series(id as string, satellite as string),
    enabled: !!id && !!satellite,
  })

export const useExplain = (id: string | null, jobId: string | null) =>
  useQuery<Explain, ApiError>({
    queryKey: [...runKey(id), 'explain', jobId],
    queryFn: () => api.explain(id as string, jobId as string),
    enabled: !!id && !!jobId,
  })

export const useCompare = (left: string | null, right: string | null) =>
  useQuery<CompareReport, ApiError>({
    queryKey: ['compare', left, right],
    queryFn: () => api.compare(left as string, right as string),
    enabled: !!left && !!right && left !== right,
    retry: false,
  })

export function useRunMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, runId: string | null) {
  const client = useQueryClient()
  return useMutation<TResult, ApiError, TArgs>({
    mutationFn: fn,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: runKey(runId) })
      client.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}
