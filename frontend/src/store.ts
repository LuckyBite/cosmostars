// What the operator is currently looking at.
//
// The one idea worth stating: the *frontier* is how far the shift has actually
// been executed, and the *cursor* is where the operator is looking. They are
// not the same thing. Executed history never moves, so the cursor may walk
// back through it freely, and everything to the right of the cursor is either
// intent or nothing at all. Scrubbing back therefore cannot change a result —
// it only changes the view.

import { create } from 'zustand'

export type Tab = 'shift' | 'canvas' | 'sats' | 'jobs' | 'branches' | 'verify' | 'jury'

export const SPEEDS = [1, 4, 8, 16, 32] as const
export type Speed = (typeof SPEEDS)[number]

interface ConsoleState {
  runId: string | null
  tab: Tab
  frontier: number
  cursor: number
  follow: boolean
  playing: boolean
  speed: Speed
  selectedSatellite: string | null
  selectedJob: string | null
  compareLeft: string | null
  compareRight: string | null

  openRun: (runId: string) => void
  closeRun: () => void
  setTab: (tab: Tab) => void
  /** Called whenever the service reports a new executed frontier. */
  syncFrontier: (step: number) => void
  setCursor: (step: number) => void
  follows: () => void
  play: () => void
  pause: () => void
  toggle: () => void
  setSpeed: (speed: Speed) => void
  selectSatellite: (id: string | null) => void
  selectJob: (id: string | null) => void
  setCompare: (side: 'left' | 'right', runId: string | null) => void
}

// The open shift survives a page reload, so an expert who refreshes does not
// land back on the catalogue. It is per-tab and best-effort: private windows and
// blocked storage simply start from the catalogue, and a run the service no
// longer holds falls back there too.
const KEY = 'cosmostars.run'

const remembered = (() => {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
})()

const remember = (runId: string | null) => {
  try {
    if (runId) sessionStorage.setItem(KEY, runId)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* storage is a convenience here, never a requirement */
  }
}

export const useConsole = create<ConsoleState>((set, get) => ({
  runId: remembered,
  tab: 'shift',
  frontier: 0,
  cursor: 0,
  follow: true,
  playing: false,
  speed: 8,
  selectedSatellite: null,
  selectedJob: null,
  compareLeft: null,
  compareRight: null,

  openRun: (runId) => set((state) => {
    remember(runId)
    return {
    runId,
    frontier: 0,
    cursor: 0,
    follow: true,
    playing: false,
    selectedSatellite: null,
    selectedJob: null,
    compareLeft: state.compareLeft ?? runId,
    }
  }),
  closeRun: () => {
    remember(null)
    set({ runId: null, frontier: 0, cursor: 0, playing: false, follow: true })
  },
  setTab: (tab) => set({ tab }),
  syncFrontier: (step) => set((state) => ({
    frontier: step,
    cursor: state.follow ? step : Math.min(state.cursor, step),
  })),
  setCursor: (step) => set((state) => {
    const cursor = Math.max(0, Math.min(step, state.frontier))
    return { cursor, follow: cursor >= state.frontier }
  }),
  follows: () => set((state) => ({ cursor: state.frontier, follow: true })),
  play: () => set((state) => ({
    playing: true,
    // Playing from the frontier would have nothing to show, so a play press at
    // the end of recorded history rewinds to the start of it.
    cursor: state.cursor >= state.frontier ? 0 : state.cursor,
    follow: false,
  })),
  pause: () => set({ playing: false }),
  toggle: () => (get().playing ? get().pause() : get().play()),
  setSpeed: (speed) => set({ speed }),
  selectSatellite: (id) => set({ selectedSatellite: id }),
  selectJob: (id) => set({ selectedJob: id }),
  setCompare: (side, runId) =>
    set(side === 'left' ? { compareLeft: runId } : { compareRight: runId }),
}))
