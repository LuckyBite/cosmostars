// The logomark: a body and the orbit around it. It is the only drawing in the
// interface that is not data, so it is one shape, drawn once, and sized by the
// caller. The shape has to survive 22 pixels in the rail — two thin arcs there
// merged into a smudge, so the orbit is one closed ellipse and the body is
// filled: at sixteen pixels of glyph both are still two separate things.

export function Mark({ size = 22 }: { size?: number }) {
  const glyph = Math.round(size * 0.72)
  // A hairline holds at small sizes; at poster size it would look anaemic.
  const stroke = size > 40 ? 1.6 : 2
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth={stroke} strokeLinecap="round">
        <ellipse cx="12" cy="12" rx="10.4" ry="4.9" transform="rotate(-30 12 12)" />
        <circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}
