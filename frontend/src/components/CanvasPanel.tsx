import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, runKey, useContacts, useDownlinkPlan, useGrid, useSlotPrices } from '../api/client'
import type { RunInfo } from '../api/types'
import { priceIndex } from '../derive'
import { useConsole } from '../store'
import { Card, Chip, Failure, Legend, Loading, Note, action, num, steps as stepsWord, usd } from '../ui'
import { JobExplain } from './JobExplain'

// The fog of war.
//
// One grid, two layers. Left of the cursor is what the shift executed, and it
// is never redrawn from new knowledge — the pixels there are the log. Right of
// the cursor is what the planner intends given what it knows right now, drawn
// pale because it is not a fact yet. A message arriving at step 72 changes the
// right-hand layer and cannot touch the left one, which is the claim the
// criterion about temporal correctness asks us to make visible.
//
// The two layers are rasterised once into offscreen canvases; moving the cursor
// only re-blits them under two clips, so playback stays smooth at any speed.

const ROW_H = 12
const MIN_CELL = 3
const LABELS = 44
/** The gap between the labels and the plot, mirrored from the stylesheet so
 *  that «вписать» fits the plot to the width that is actually left for it. */
const GAP = 6
/** How far the canvas may be pulled in and pushed out around «вписать». */
const ZOOM_MIN = 1
const ZOOM_MAX = 8
const ZOOM_STEP = 1.35
/** Taller than this and the canvas stops growing: it starts panning. */
const VIEW_MAX = 620

/** How pale the intent layer is drawn. It is a plan, not a fact. */
const INTENT_ALPHA = 0.3

interface Palette {
  plane: string; inset: string; idle: string; line: string
  d: string; r: string; c: string; x: string; off: string; ink: string
}

function palette(element: HTMLElement): Palette {
  const style = getComputedStyle(element)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    plane: token('--surface'), inset: token('--inset'), idle: token('--idle'),
    line: token('--line-soft'), d: token('--s1'), r: token('--s3'), c: token('--s2'),
    x: token('--crit'), off: token('--off'), ink: token('--ink'),
  }
}

export function CanvasPanel({ run }: { run: RunInfo }) {
  const cursor = useConsole((s) => s.cursor)
  const selectJob = useConsole((s) => s.selectJob)
  const setCursor = useConsole((s) => s.setCursor)
  const grid = useGrid(run.run_id)
  const plan = useDownlinkPlan(run.run_id)
  const contacts = useContacts(run.run_id)
  const prices = useSlotPrices(run.run_id)
  const client = useQueryClient()

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layers = useRef<{ fact: HTMLCanvasElement; intent: HTMLCanvasElement } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1080)
  const [hover, setHover] = useState<{ x: number; y: number; sid: string; step: number } | null>(null)
  // Zoom 1 is «вписать»: the whole shift across the available width. Above it
  // the canvas is bigger than its window and the operator drags it around,
  // which is what a scrollbar under a 288-step grid was pretending to do.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  const total = grid.data?.total_steps ?? run.total_steps
  const sats = grid.data?.satellites ?? []
  const fitCell = Math.max(MIN_CELL, (width - LABELS - GAP) / total)
  const cell = fitCell * zoom
  const rowH = ROW_H * zoom
  const plotW = Math.round(cell * total)
  const plotH = Math.round(rowH * sats.length)
  const viewW = Math.max(0, width - LABELS - GAP)
  const viewH = Math.min(plotH, VIEW_MAX)
  const index = useMemo(() => priceIndex(prices.data?.prices), [prices.data])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(host)
    setWidth(host.clientWidth)
    return () => observer.disconnect()
  }, [])

  // --- rasterise both layers ------------------------------------------------
  useEffect(() => {
    if (!grid.data || !canvasRef.current || !sats.length) return
    const colors = palette(canvasRef.current)
    const make = () => {
      const surface = document.createElement('canvas')
      surface.width = plotW
      surface.height = plotH
      return surface
    }
    const fact = make()
    const intent = make()
    const fc = fact.getContext('2d')!
    const ic = intent.getContext('2d')!

    fc.fillStyle = colors.plane
    fc.fillRect(0, 0, plotW, plotH)
    ic.fillStyle = colors.plane
    ic.fillRect(0, 0, plotW, plotH)

    // A column's edges are whole pixels; its width is whatever is left between
    // them, so 288 columns tile the canvas exactly and none of them blur.
    const left = (step: number) => Math.round(step * cell)
    const span = (from: number, to: number) => Math.max(left(to) - left(from), 1)

    // Layer one: the log.
    sats.forEach((sid, row) => {
      const line = grid.data.actions[sid] ?? ''
      const y = row * rowH
      for (let step = 0; step < total; step++) {
        const code = line.charCodeAt(step)
        const fill = code === 100 ? colors.d : code === 114 ? colors.r
          : code === 99 ? colors.c : code === 120 ? colors.x
          : code === 46 ? colors.idle : null
        if (!fill) continue
        fc.fillStyle = fill
        fc.fillRect(left(step), y + 1, span(step, step + 1), rowH - 2)
      }
    })

    // Layer two: contacts the planner can still use, and the transmissions it
    // has committed to. Nothing here has happened yet.
    const rowOf = new Map(sats.map((sid, row) => [sid, row]))
    ic.fillStyle = colors.idle
    for (const item of contacts.data?.items ?? []) {
      const row = rowOf.get(item.satellite_id)
      if (row === undefined) continue
      for (const [from, to] of item.downlink) {
        for (let step = from; step < Math.min(to, total); step++) {
          ic.fillRect(left(step), row * rowH + rowH / 2 - 1, span(step, step + 1), 2)
        }
      }
    }
    const assignments = plan.data?.plan?.assignments ?? {}
    ic.fillStyle = colors.d
    for (const [step, byS] of Object.entries(assignments)) {
      const k = Number(step)
      for (const sid of Object.keys(byS)) {
        const row = rowOf.get(sid)
        if (row === undefined) continue
        ic.fillRect(left(k), row * rowH + 1, span(k, k + 1), rowH - 2)
      }
    }
    // Announced unavailability applies to both sides of the cursor.
    for (const outage of contacts.data?.outages ?? []) {
      const row = rowOf.get(outage.satellite_id)
      if (row === undefined) continue
      for (const context of [fc, ic]) {
        context.fillStyle = colors.off
        context.fillRect(left(outage.start_step), row * rowH + 1,
                         span(outage.start_step, outage.end_step), rowH - 2)
      }
    }
    layers.current = { fact, intent }
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.data, plan.data, contacts.data, cell, rowH, plotW, plotH, total, sats.length])

  // --- per-frame blit -------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const pair = layers.current
    if (!canvas || !pair) return
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== plotW * ratio || canvas.height !== plotH * ratio) {
      canvas.width = plotW * ratio
      canvas.height = plotH * ratio
    }
    const context = canvas.getContext('2d')!
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, plotW, plotH)
    const split = Math.round(Math.min(cursor, total) * cell)

    context.save()
    context.beginPath()
    context.rect(split, 0, plotW - split, plotH)
    context.clip()
    context.globalAlpha = INTENT_ALPHA
    context.drawImage(pair.intent, 0, 0)
    context.restore()

    context.save()
    context.beginPath()
    context.rect(0, 0, split, plotH)
    context.clip()
    context.drawImage(pair.fact, 0, 0)
    context.restore()

    const colors = palette(canvas)
    context.fillStyle = colors.ink
    context.fillRect(split - 0.5, 0, 1, plotH)
  }, [cursor, cell, plotW, plotH, total])

  useEffect(draw, [draw])

  // The canvas cannot be dragged off its own window: clamping happens in one
  // place so that zooming, resizing and dragging all obey the same bounds.
  const clamp = useCallback((next: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(viewW - plotW, next.x)),
    y: Math.min(0, Math.max(viewH - plotH, next.y)),
  }), [viewW, plotW, viewH, plotH])

  useEffect(() => { setPan((prev) => clamp(prev)) }, [clamp])

  // Zooming keeps the point under the pointer where it was; anything else and
  // the operator loses the step they were looking at.
  const zoomAround = useCallback((factor: number, originX: number, originY: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor))
    if (next === zoom) return
    const scale = next / zoom
    setZoom(next)
    setPan((prev) => ({
      x: originX - scale * (originX - prev.x),
      y: originY - scale * (originY - prev.y),
    }))
  }, [zoom])

  const fitAll = () => { setZoom(1); setPan({ x: 0, y: 0 }) }
  const zoomFromCentre = (factor: number) => zoomAround(factor, viewW / 2, viewH / 2)

  // React listens for wheel passively, and a passive listener may not stop the
  // page from scrolling — so this one is attached by hand.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = view.getBoundingClientRect()
      zoomAround(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
                 event.clientX - box.left, event.clientY - box.top)
    }
    view.addEventListener('wheel', onWheel, { passive: false })
    return () => view.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  // A press is a drag or a click, and which one it was is known only when it
  // ends: four pixels of travel separate «поставить курсор» from «подвинуть».
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number }; moved: boolean } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, pan, moved: false }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = drag.current
    if (!active) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    if (!active.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    active.moved = true
    setHover(null)
    setPan(clamp({ x: active.pan.x + dx, y: active.pan.y + dy }))
  }
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = drag.current
    drag.current = null
    if (!active || active.moved) return
    const hit = cellAt(event)
    if (!hit) return
    setCursor(hit.step)
    void resolveJob(hit.sid, hit.step)
  }

  const cellAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const step = Math.floor(((event.clientX - box.left) / box.width) * total)
    const row = Math.floor(((event.clientY - box.top) / box.height) * sats.length)
    if (step < 0 || step >= total || row < 0 || row >= sats.length) return null
    return { sid: sats[row], step }
  }

  const resolveJob = async (sid: string, step: number) => {
    if (step >= cursor) {
      const planned = plan.data?.plan?.assignments?.[String(step)]?.[sid]
      if (planned) { selectJob(planned); return }
    }
    const log = await client.fetchQuery({
      queryKey: [...runKey(run.run_id), 'trace', sid],
      queryFn: () => api.trace(run.run_id, { satellite_id: sid, limit: 20000 }),
    })
    const row = log.items.find((item) => item.step === step)
    const jobId = row?.requested?.job_id ?? row?.completed_job ?? null
    if (jobId) selectJob(jobId)
  }

  const factOf = (sid: string, step: number) => {
    const code = grid.data?.actions[sid]?.[step]
    return code === 'd' ? 'Передача на Землю' : code === 'r' ? 'Ретрансляция'
      : code === 'c' ? 'Калибровка' : code === 'x' ? 'Команда отклонена'
      : code === '.' ? 'Простой' : 'Ещё не исполнено'
  }

  return (
    <>
      <Failure error={grid.error ?? plan.error} what="Полотно не построилось" />
      <Card
        title={<>Полотно смены · {sats.length} × {total}</>}
        note="Слева от курсора — факт: что исполнилось. Справа — намерение планировщика при текущем знании, бледным. Курсор двигается по исполненной истории, и левая часть не меняется ни на пиксель."
        right={<Legend items={[
          { color: 'var(--s1)', label: 'Связь' },
          { color: 'var(--s3)', label: 'Ретрансляция' },
          { color: 'var(--s2)', label: 'Калибровка' },
          { color: 'var(--crit)', label: 'Отклонено' },
          { color: 'var(--idle)', label: 'Простой / контакт' },
          { color: 'var(--off)', label: 'Недоступен' },
        ]} />}
      >
        {grid.isPending ? <Loading what="Сетка смены" /> : (
          <>
          <div className="canvas-zoom">
            <button className="btn slim" onClick={() => zoomFromCentre(1 / ZOOM_STEP)}
                    disabled={zoom <= ZOOM_MIN} aria-label="Отдалить">−</button>
            <span className="mono">{Math.round(zoom * 100)}%</span>
            <button className="btn slim" onClick={() => zoomFromCentre(ZOOM_STEP)}
                    disabled={zoom >= ZOOM_MAX} aria-label="Приблизить">+</button>
            <button className="btn slim" onClick={fitAll} disabled={zoom === 1}>Вписать</button>
            <i>Ctrl + колесо — масштаб. Перетаскивание — по полотну. Клик — курсор на шаг.</i>
          </div>
          <div className="canvas-host" ref={hostRef}>
            <div className="canvas-rows" style={{ width: LABELS, height: viewH }}>
              <div className="canvas-rows-inner" style={{ transform: `translateY(${pan.y}px)` }}>
                {sats.map((sid) => (
                  <button key={sid} className="canvas-row-label" style={{ height: rowH }}
                          onClick={() => useConsole.getState().selectSatellite(sid)}>{sid}</button>
                ))}
              </div>
            </div>
            <div className="canvas-view" ref={viewRef} style={{ height: viewH }}>
            <canvas
              ref={canvasRef}
              className="canvas-plot"
              style={{ width: plotW, height: plotH, transform: `translate(${pan.x}px, ${pan.y}px)` }}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(event) => {
                if (drag.current?.moved) return
                const hit = cellAt(event)
                setHover(hit ? { ...hit, x: event.clientX, y: event.clientY } : null)
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { drag.current = null }}
            />
            </div>
            {hover && (
              <div className="tip" style={{ display: 'block', left: hover.x + 14, top: hover.y + 12 }}>
                <b>{hover.sid} · шаг {hover.step}</b>
                <ul>
                  <li><span>{hover.step < cursor ? 'Факт' : 'Намерение'}</span>
                      <em>{hover.step < cursor ? factOf(hover.sid, hover.step)
                        : (plan.data?.plan?.assignments?.[String(hover.step)]?.[hover.sid] ?? '—')}</em></li>
                  <li><span>Заряд</span>
                      <em>{grid.data?.soc[hover.sid]?.[hover.step] ?? '—'}%</em></li>
                  {index.has(`${hover.step}:${hover.sid}`) && (
                    <li><span>Цена слота</span>
                        <em>{usd(index.get(`${hover.step}:${hover.sid}`)!.price)}</em></li>
                  )}
                </ul>
              </div>
            )}
          </div>
          </>
        )}
        <div className="canvas-sides" style={{ paddingLeft: LABELS }} aria-hidden>
          <span>← факт</span>
          <span>намерение →</span>
        </div>
        <div className="readout">
          <span>Курсор на шаге <b>{cursor}</b></span>
          <span>Исполнено до <b>{run.step}</b></span>
          {plan.data?.plan && <>
            <span>В расписании связи <b>{num(plan.data.plan.selected_jobs.length)}</b> заданий</span>
            <span>Недостижимо <b>{num(plan.data.plan.unreachable.length)}</b></span>
            <span>Снято отбором <b>{num(plan.data.plan.displaced.length)}</b></span>
            <span>Расписание построено на шаге <b>{plan.data.plan.built_at_step}</b></span>
          </>}
        </div>
        {!plan.data?.plan && (
          <Note><span>
            У этого планировщика нет расписания связи заранее — он решает пошагово, поэтому
            правее курсора показывать нечего, кроме окон контакта.
          </span></Note>
        )}
        <p className="tbl-note">
          Клик по клетке ставит курсор на этот шаг и открывает разбор задания, которое там
          стояло. Клик по имени аппарата открывает его на экране «Аппараты».
          {run.events_received > 0 && <> Сообщений получено: {run.events_received} — отмотайте
          курсор к отметке на таймлайне и сравните левую часть до и после.</>}
        </p>
      </Card>

      <div className="two">
        <JobExplain run={run} />
        <Card title="Что стоит за клеткой"
              note="Полотно рисуется из одного источника: журнала модели на 48 × 288 значений. Каждая клетка — одно решение оператора и его результат.">
          <dl className="dl">
            <dt>Аппаратов</dt><dd>{sats.length}</dd>
            <dt>Шагов</dt><dd>{total}</dd>
            <dt>Клеток</dt><dd>{num(sats.length * total)}</dd>
            <dt>Отклонённых команд</dt><dd>{num(run.summary.blocked_command_count)}</dd>
            <dt>Аппарато-шагов ниже резерва</dt><dd>{num(run.summary.below_reserve_satellite_steps)}</dd>
            <dt>Работа впустую</dt><dd>{stepsWord(run.summary.work_steps_in_missed_jobs)}</dd>
          </dl>
          <p className="tbl-note">
            «Работа впустую» — шаги, потраченные на задания, которые так и не были завершены.
            {run.summary.work_steps_in_missed_jobs === 0
              ? ' Здесь она нулевая: планировщик не начинает то, что не может закончить.'
              : ' Ненулевая величина показывает, где расписание пришлось ломать по ходу смены.'}
          </p>
          {run.parent_id && (
            <Note><span>
              Это ветвь от <Chip>{run.parent_id.slice(0, 6)}</Chip> с шага{' '}
              <b>{run.forked_at_step}</b>: до этого шага полотно совпадает с родительским
              по построению, дальше — расходится.
            </span></Note>
          )}
          <p className="tbl-note">
            Последнее действие аппарата и причина отказа доступны на экране «Аппараты»:
            строка <b>{action('job')}</b> в журнале означает работу по заданию.
          </p>
        </Card>
      </div>
    </>
  )
}
