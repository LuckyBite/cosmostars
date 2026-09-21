import { useEffect, useRef } from 'react'
import { Pause, Play, Rewind } from 'lucide-react'
import { useEvents } from '../api/client'
import type { RunInfo } from '../api/types'
import { SPEEDS, useConsole, type Speed } from '../store'
import { EVENT_KINDS, clock } from '../ui'

// Playback speed in steps per second. A shift is 288 steps, so x1 walks it in
// under two minutes and x32 in about four seconds. This plays back history that
// has already been computed: the statement is explicit that five minutes of
// model time must not cost the user five minutes of waiting.
const STEPS_PER_SECOND = 2.5

export function Timeline({ run }: { run: RunInfo }) {
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
    ...(events?.items ?? []).map((item) => ({
      step: item.at_step,
      kind: item.type,
      label: EVENT_KINDS[item.type] ?? item.type,
    })),
    ...run.goal_switches.map((item) => ({
      step: item.step, kind: 'goal', label: `цель: ${item.goal}`,
    })),
  ].sort((a, b) => a.step - b.step)

  const at = (step: number) => `${(100 * step) / run.total_steps}%`

  return (
    <div className="ribbon">
      <div className="wrap">
        <div className="ribbon-head">
          <h2>Сутки смены · шаг 5 минут</h2>
          <p>
            Слева от курсора — исполненная история, она не пересчитывается.
            {frontier < run.total_steps && <> Рассчитано до шага {frontier}.</>}
          </p>
        </div>

        <div className="track">
          <div className="track-bg" />
          <div className="track-done" style={{ width: at(frontier) }} />
          <div className="track-cursor" style={{ left: at(cursor) }} aria-hidden />
          {marks.map((mark, i) => (
            <button key={i} className={'evt' + (mark.step / run.total_steps > 0.82 ? ' flip' : '')}
                    data-kind={mark.kind} data-row={i % 2}
                    style={{ left: at(mark.step) }}
                    title={`${mark.label} · шаг ${mark.step}`}
                    onClick={() => { pause(); setCursor(mark.step) }}>
              <span /><em>{mark.step}</em>
            </button>
          ))}
          <input type="range" min={0} max={run.total_steps} value={cursor}
                 aria-label="Курсор смены"
                 onChange={(e) => { pause(); setCursor(Number(e.target.value)) }} />
        </div>

        <div className="hours">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i}>{clock((i * run.total_steps) / 8)}</span>
          ))}
        </div>

        <div className="playback">
          <button className="btn" onClick={toggle} disabled={frontier === 0}>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            {playing ? 'пауза' : 'проигрывание'}
          </button>
          <div className="speeds" role="group" aria-label="Скорость проигрывания">
            {SPEEDS.map((value: Speed) => (
              <button key={value} className="pill" aria-pressed={speed === value}
                      onClick={() => setSpeed(value)}>×{value}</button>
            ))}
          </div>
          <span className="readout">
            курсор <b>{cursor}</b> · {clock(cursor)}
            {!follow && (
              <button className="btn slim" onClick={follows}>
                <Rewind size={12} aria-hidden style={{ transform: 'scaleX(-1)' }} /> к фронту расчёта
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
