import { useEffect, useRef } from 'react'
import { Pause, Play, Rewind } from 'lucide-react'
import { api, useEvents, useRunMutation } from '../api/client'
import type { RunInfo } from '../api/types'
import { SPEEDS, useConsole, type Speed } from '../store'
import { Failure, clock } from '../ui'

// Time, pinned to the bottom of the window.
//
// The cursor of a shift is global state — every screen is read at a step — so
// it cannot live inside one of them. Two different motions meet here and are
// kept apart on purpose: "Шаг", "Час" and "Досчитать смену" advance the model
// and move the frontier forward, while play and the scrubber only walk the
// cursor back and forth through history that has already been computed.
//
// Playback speed in steps per second. A shift is 288 steps, so ×1 walks it in
// under two minutes and ×32 in about four seconds: the statement is explicit
// that five minutes of model time must not cost five minutes of waiting.
const STEPS_PER_SECOND = 2.5

const MARK_TONE: Record<string, string> = {
  add_jobs: 'var(--s1)',
  satellite_outage: 'var(--crit)',
  close_downlink: 'var(--serious)',
  goal: 'var(--s3)',
}

export function Transport({ run }: { run: RunInfo }) {
  const { data: events } = useEvents(run.run_id)
  const cursor = useConsole((s) => s.cursor)
  const frontier = useConsole((s) => s.frontier)
  const follow = useConsole((s) => s.follow)
  const playing = useConsole((s) => s.playing)
  const speed = useConsole((s) => s.speed)
  const setCursor = useConsole((s) => s.setCursor)
  const setSpeed = useConsole((s) => s.setSpeed)
  const toggle = useConsole((s) => s.toggle)
  const pause = useConsole((s) => s.pause)
  const follows = useConsole((s) => s.follows)

  const advance = useRunMutation(
    (body: { steps?: number; to_step?: number }) => api.advance(run.run_id, body), run.run_id)
  const step = (body: { steps?: number; to_step?: number }) => { pause(); advance.mutate(body) }

  // One animation frame loop, accumulating fractional steps, so the cursor
  // moves smoothly at every speed instead of stuttering on a timer.
  const carry = useRef(0)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000
      last = now
      carry.current += elapsed * STEPS_PER_SECOND * speed
      if (carry.current >= 1) {
        const whole = Math.floor(carry.current)
        carry.current -= whole
        const state = useConsole.getState()
        const next = state.cursor + whole
        if (next >= state.frontier) {
          state.setCursor(state.frontier)
          state.pause()
          return
        }
        state.setCursor(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed])

  const marks = [
    ...(events?.items ?? []).map((item) => ({ step: item.at_step, kind: item.type })),
    ...run.goal_switches.map((item) => ({ step: item.step, kind: 'goal' })),
  ].sort((a, b) => a.step - b.step)

  const at = (value: number) => `${(100 * value) / run.total_steps}%`

  const scrubRef = useRef<HTMLDivElement>(null)
  const scrubTo = (clientX: number) => {
    const box = scrubRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const ratio = (clientX - box.left) / box.width
    pause()
    setCursor(Math.round(Math.max(0, Math.min(1, ratio)) * run.total_steps))
  }

  const nudge = (delta: number) => { pause(); setCursor(cursor + delta) }

  return (
    <div className="transport">
      <div className="transport-inner">
        <Failure error={advance.error} what="Шаг не выполнен" />

        <div className="transport-row">
          <button className="play" onClick={toggle} disabled={frontier === 0}
                  aria-label={playing ? 'Пауза' : 'Проигрывание'}
                  title={playing ? 'Пауза' : 'Проиграть записанную историю'}>
            {playing ? <Pause size={15} fill="currentColor" strokeWidth={0} />
              : <Play size={15} fill="currentColor" strokeWidth={0} />}
          </button>
          <button className="btn" disabled={advance.isPending || run.finished}
                  onClick={() => step({ steps: 1 })}>Шаг</button>
          <button className="btn" disabled={advance.isPending || run.finished}
                  onClick={() => step({ steps: 12 })}>Час</button>
          <button className="btn" disabled={advance.isPending || run.finished}
                  onClick={() => step({ to_step: run.total_steps })}>Досчитать смену</button>

          <div className="clock">
            <b>{clock(cursor)}</b>
            <i>Шаг {cursor} из {run.total_steps}</i>
          </div>
          {!follow && (
            <button className="btn slim" onClick={follows} title="Вернуть курсор к фронту расчёта">
              <Rewind size={12} aria-hidden style={{ transform: 'scaleX(-1)' }} /> К фронту
            </button>
          )}

          <div className="speeds" role="group" aria-label="Скорость проигрывания">
            <span>Скорость</span>
            {SPEEDS.map((value: Speed) => (
              <button key={value} aria-pressed={speed === value}
                      onClick={() => setSpeed(value)}>×{value}</button>
            ))}
          </div>
        </div>

        <div
          ref={scrubRef}
          className="scrub"
          role="slider"
          tabIndex={0}
          aria-label="Курсор смены"
          aria-valuemin={0}
          aria-valuemax={run.total_steps}
          aria-valuenow={cursor}
          aria-valuetext={`Шаг ${cursor}, ${clock(cursor)}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            scrubTo(event.clientX)
          }}
          onPointerMove={(event) => { if (event.buttons === 1) scrubTo(event.clientX) }}
          onKeyDown={(event) => {
            const jump = { ArrowLeft: -1, ArrowRight: 1, PageDown: -12, PageUp: 12 }[event.key]
            if (jump !== undefined) { event.preventDefault(); nudge(jump) }
            else if (event.key === 'Home') { event.preventDefault(); nudge(-cursor) }
            else if (event.key === 'End') { event.preventDefault(); follows() }
          }}
        >
          <div className="scrub-track" />
          <div className="scrub-done" style={{ width: at(frontier) }} />
          <div className="scrub-seen" style={{ width: at(cursor) }} />
          {marks.map((mark, i) => (
            <div key={i} className="scrub-mark"
                 style={{ left: at(mark.step), ['--tone' as string]: MARK_TONE[mark.kind] }}>
              <span /><em>{mark.step}</em>
            </div>
          ))}
          <div className="scrub-cursor" style={{ left: at(cursor) }} />
        </div>

        <div className="hours">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i}>{clock((i * run.total_steps) / 4)}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
