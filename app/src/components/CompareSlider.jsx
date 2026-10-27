import { useCallback, useRef, useState } from 'react'

// Before/after slider. Pointer events cover mouse, touch, and pen; the hidden
// range input makes it keyboard and screen-reader accessible.
export default function CompareSlider({ before, after, beforeLabel = 'Before', afterLabel = 'After', aspect, className = '' }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(50)
  const dragging = useRef(false)

  const update = useCallback((clientX) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }, [])

  return (
    <div
      ref={ref}
      className={`compare ${className}`}
      style={aspect ? { aspectRatio: aspect } : undefined}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        update(e.clientX)
      }}
      onPointerMove={(e) => dragging.current && update(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <img src={after} alt={afterLabel} className="compare-img" draggable={false} />
      <div className="compare-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={before} alt={beforeLabel} className="compare-img" draggable={false} />
      </div>
      <span className="compare-tag compare-tag--before">{beforeLabel}</span>
      <span className="compare-tag compare-tag--after">{afterLabel}</span>
      <div className="compare-handle" style={{ left: `${pos}%` }}>
        <div className="compare-knob">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7 4l-5 6 5 6M13 4l5 6-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <input
        className="compare-range"
        type="range"
        min="0"
        max="100"
        value={Math.round(pos)}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="Drag to compare before and after"
      />
    </div>
  )
}
