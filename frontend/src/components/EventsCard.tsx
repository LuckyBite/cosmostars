import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileUp, Inbox, Send } from 'lucide-react'
import { api, runKey, useEvents, useRunMutation, useSatellites } from '../api/client'
import type { CaseEvent, RunInfo } from '../api/types'
import { useConsole } from '../store'
import { Card, Chip, EVENT_KINDS, Empty, Failure, Note, num } from '../ui'

/** A message the interface composes itself, for the demonstration path. */
function demoJobs(run: RunInfo, satellites: string[]): CaseEvent {
  const step = run.step
  const room = run.total_steps - step
  const slack = Math.max(2, Math.min(10, room))
  const tag = Date.now().toString(36).slice(-4).toUpperCase()
  const crew = satellites.slice(0, 3)
  return {
    id: `UI-jobs-${tag}`,
    at_step: step,
    type: 'add_jobs',
    jobs: [
      {
        id: `URG-${tag}-1`, kind: 'relay', release_step: step,
        deadline_step: step + slack, work_steps: Math.min(3, slack),
        eligible_satellites: crew, priority: 3, value_usd: 40,
      },
      {
        id: `URG-${tag}-2`, kind: 'relay', release_step: step,
        deadline_step: step + slack, work_steps: Math.min(2, slack),
        eligible_satellites: crew, priority: 3, value_usd: 70,
      },
    ],
  }
}

export function EventsCard({ run }: { run: RunInfo }) {
  const { data: sats } = useSatellites(run.run_id)
  const { data: events } = useEvents(run.run_id)
  const client = useQueryClient()
  const setCursor = useConsole((s) => s.setCursor)
  const [ids, setIds] = useState('')
  const [until, setUntil] = useState('')
  const [raw, setRaw] = useState('')
  const [fileNote, setFileNote] = useState<string | null>(null)

  const satellites = (sats?.items ?? []).map((item) => item.satellite_id)
  const post = useRunMutation((event: unknown) => api.event(run.run_id, event), run.run_id)
  const outage = useRunMutation(
    (body: { satellite_ids: string[]; end_step: number }) => api.outage(run.run_id, body), run.run_id)
  const close = useRunMutation(
    (body: { satellite_ids: string[]; end_step: number }) => api.closeDownlink(run.run_id, body), run.run_id)

  const parseIds = () => ids.toUpperCase().split(/[\s,;]+/).filter(Boolean)
  const endStep = () => {
    const value = Number(until)
    return Number.isFinite(value) && value > run.step ? Math.trunc(value) : run.step + 24
  }
  const interval = () => ({ satellite_ids: parseIds(), end_step: endStep() })
  const busy = post.isPending || outage.isPending || close.isPending

  // A message file is received the way a shift would receive it: the clock is
  // moved to the announced step first, then the message is handed over. Nothing
  // is applied ahead of its own step, and a refusal stops the file there.
  const playFile = async (file: File) => {
    setFileNote(null)
    let applied = 0
    let step = run.step
    try {
      const parsed = JSON.parse(await file.text())
      const list: CaseEvent[] = Array.isArray(parsed) ? parsed : (parsed.events ?? [])
      for (const event of list) {
        if (typeof event.at_step === 'number' && event.at_step > step) {
          step = (await api.advance(run.run_id, { to_step: event.at_step })).step
        }
        step = (await api.event(run.run_id, event)).step
        applied++
      }
      setFileNote(applied === 0
        ? 'В файле не нашлось сообщений.'
        : `Принято сообщений: ${applied}. Расчёт доведён до шага ${step}.`)
    } catch (error) {
      setFileNote(`Остановились на сообщении №${applied + 1}: ${(error as Error).message}`)
    } finally {
      client.invalidateQueries({ queryKey: runKey(run.run_id) })
    }
  }

  return (
    <Card title="Сообщения в смену"
          note="Три типа сообщений кейса — файлом и руками. Сообщение применяется с шага получения: исполненная история не пересчитывается, а некорректное сообщение отклоняется вместе со своей причиной и не портит состояние.">
      <Failure error={post.error} what="Сообщение отклонено" />
      <Failure error={outage.error} what="Недоступность не принята" />
      <Failure error={close.error} what="Отмена сеансов не принята" />
      {fileNote && <Note><span>{fileNote}</span></Note>}

      <div className="event-forms">
        <div className="field grow">
          <label htmlFor="ev-ids">Аппараты</label>
          <input id="ev-ids" value={ids} placeholder="S09, S10, S11"
                 onChange={(e) => setIds(e.target.value)} list="sat-ids" />
          <datalist id="sat-ids">
            {satellites.map((sid) => <option key={sid} value={sid} />)}
          </datalist>
          <span className="hint">
            {satellites.slice(0, 6).map((sid) => (
              <button key={sid} className="pill" type="button"
                      onClick={() => setIds((prev) => (prev ? prev + ', ' : '') + sid)}>{sid}</button>
            ))}
          </span>
        </div>
        <div className="field">
          <label htmlFor="ev-until">До шага</label>
          <input id="ev-until" inputMode="numeric" value={until} placeholder={String(run.step + 24)}
                 onChange={(e) => setUntil(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="acts">
          <button className="btn" disabled={busy || !parseIds().length}
                  onClick={() => outage.mutate(interval())}>
            недоступность аппаратов
          </button>
          <button className="btn" disabled={busy || !parseIds().length}
                  onClick={() => close.mutate(interval())}>
            отмена сеансов связи
          </button>
          <button className="btn" disabled={busy || !satellites.length}
                  onClick={() => post.mutate(demoJobs(run, satellites))}>
            <Send size={14} aria-hidden /> срочные задания
          </button>
          <label className="btn">
            <FileUp size={14} aria-hidden /> файл сообщений
            <input type="file" accept="application/json" hidden
                   onChange={(e) => e.target.files?.[0] && playFile(e.target.files[0])} />
          </label>
        </div>
      </div>

      <details className="raw-event">
        <summary>Своё сообщение в формате кейса</summary>
        <textarea value={raw} rows={6} spellCheck={false}
                  placeholder={`{"id": "E-01", "at_step": ${run.step}, "type": "close_downlink", "satellite_ids": ["S09"], "end_step": ${Math.min(run.step + 24, run.total_steps)}}`}
                  onChange={(e) => setRaw(e.target.value)} />
        <button className="btn" disabled={busy || !raw.trim()} onClick={() => {
          try {
            post.mutate(JSON.parse(raw))
          } catch (error) {
            setFileNote(`Это не JSON: ${(error as Error).message}`)
          }
        }}>
          отправить в смену
        </button>
      </details>

      <h4 className="sub-head"><Inbox size={13} aria-hidden /> Принято сообщений: {num(events?.items.length ?? 0)}</h4>
      {!events?.items.length ? (
        <Empty>Сообщений пока не было. Всё, что видно на экране, посчитано на исходном знании.</Empty>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Шаг</th><th>Идентификатор</th><th>Тип</th><th>Состав</th><th>До шага</th></tr>
            </thead>
            <tbody>
              {events.items.map((event) => (
                <tr key={event.id} onClick={() => setCursor(event.at_step)}>
                  <td className="num">{event.at_step}</td>
                  <td className="id">{event.id}</td>
                  <td><Chip tone={event.type === 'add_jobs' ? 'good' : 'ser'}>
                    {EVENT_KINDS[event.type] ?? event.type}</Chip></td>
                  <td>{event.type === 'add_jobs'
                    ? `${event.jobs?.length ?? 0} заданий`
                    : (event.satellite_ids ?? []).join(', ')}</td>
                  <td className="num">{event.end_step ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
