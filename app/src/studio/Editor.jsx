import { useState } from 'react'
import { hitTest, NORM } from '../lib/geometry.js'
import CompareSlider from '../components/CompareSlider.jsx'

const pointsAttr = (poly) => poly.map(([x, y]) => `${x},${y}`).join(' ')

// The photo with a tappable SVG overlay. The SVG uses the same 0-1000 space as
// Gemini's polygons, so no coordinate conversion is needed to draw them.
export default function Editor({ photo, url, originalUrl, objects, selectedId, onSelect, busy, compare, showOutlines }) {
  const [hoverId, setHoverId] = useState(null)
  const ar = photo ? `${photo.width} / ${photo.height}` : '3 / 2'

  const toNorm = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - rect.left) / rect.width) * NORM, ((e.clientY - rect.top) / rect.height) * NORM]
  }

  const selected = objects.find((o) => o.id === selectedId)
  const hovered = objects.find((o) => o.id === hoverId)

  if (!photo || !url) {
    return (
      <div className="editor editor--empty" style={{ '--ar': ar }}>
        <div className="spinner" />
      </div>
    )
  }

  if (compare) {
    return (
      <div className="editor" style={{ '--ar': ar }}>
        <CompareSlider before={originalUrl} after={url} beforeLabel="Original" afterLabel="Edited" aspect={ar} />
      </div>
    )
  }

  return (
    <div className="editor" style={{ '--ar': ar }}>
      <img src={url} alt={photo.name} className="editor-img" draggable={false} />
      <svg
        className={`editor-overlay ${busy ? 'is-busy' : ''}`}
        viewBox={`0 0 ${NORM} ${NORM}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Tap a piece of furniture to select it"
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse' || busy) return
          setHoverId(hitTest(objects, toNorm(e))?.id ?? null)
        }}
        onPointerLeave={() => setHoverId(null)}
        onClick={(e) => {
          if (busy) return
          const hit = hitTest(objects, toNorm(e))
          onSelect(hit ? (hit.id === selectedId ? null : hit.id) : null)
        }}
      >
        {objects.map((o) => {
          const state = o.id === selectedId ? 'selected' : o.id === hoverId ? 'hover' : showOutlines ? 'idle' : 'hidden'
          return <polygon key={o.id} points={pointsAttr(o.mask)} className={`obj obj--${state}`} vectorEffect="non-scaling-stroke" />
        })}
      </svg>
      {selected && !busy && (
        <span className="editor-chip" style={{ left: `${selected.box_2d[1] / 10}%`, top: `${selected.box_2d[0] / 10}%` }}>
          {selected.label}
        </span>
      )}
      {hovered && hovered.id !== selectedId && !busy && (
        <span className="editor-chip editor-chip--hover" style={{ left: `${hovered.box_2d[1] / 10}%`, top: `${hovered.box_2d[0] / 10}%` }}>
          {hovered.label}
        </span>
      )}
      {busy && (
        <div className="editor-busy" role="status" aria-live="polite">
          <div className="spinner" />
          <p>{busy}</p>
        </div>
      )}
    </div>
  )
}
