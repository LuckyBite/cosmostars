// The logomark: a satellite drawn as a body and two arcs of orbit. It is the
// only drawing in the interface that is not data, so it is one shape, drawn
// once, and sized by the caller.

export function Mark({ size = 22 }: { size?: number }) {
  const glyph = Math.round(size * 0.6)
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
        <circle cx="12" cy="12" r="2.6" />
        <path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
        {size > 24 && <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" />}
      </svg>
    </span>
  )
}
