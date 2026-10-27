import { useState } from 'react'
import { Eraser, Lock, Palette, RefreshCw, ScanSearch, Sofa, Sparkles, Undo2, Redo2, Wand2, CopyCheck, X } from 'lucide-react'
import { ROOM_TYPES, STYLES, STYLE_IDS } from '../ai/prompts.js'

const SWATCHES = [
  { name: 'Navy', hex: '#1f2a44' },
  { name: 'Charcoal', hex: '#3a3f45' },
  { name: 'Forest', hex: '#2f4a3a' },
  { name: 'Sage', hex: '#8a9a7b' },
  { name: 'Terracotta', hex: '#b5653d' },
  { name: 'Mustard', hex: '#c9a227' },
  { name: 'Blush', hex: '#d8a7a0' },
  { name: 'Ivory', hex: '#efe8dc' },
]

const RESTYLE_IDEAS = ['black leather', 'white boucle', 'light oak', 'brushed brass', 'green velvet']
const REPLACE_IDEAS = ['mid-century modern', 'Scandinavian', 'modern luxury', 'rustic farmhouse']

function LockedHint({ onUnlock }) {
  return (
    <button className="locked" onClick={onUnlock}>
      <Lock size={14} /> Needs your Gemini key
    </button>
  )
}

function ObjectCard({ object, objects, live, canDemoRemove, onAction, onUnlock, busy }) {
  const [restyle, setRestyle] = useState('')
  const [replace, setReplace] = useState('')
  const children = (object.children || []).map((id) => objects.find((o) => o.id === id)).filter(Boolean)
  const canRemove = live || canDemoRemove

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <h3>{object.label}</h3>
        {children.length > 0 && <span className="muted small">+ {children.map((c) => c.label).join(', ')} on it</span>}
      </div>

      <div className="action">
        <div className="action-title">
          <Eraser size={15} /> Remove
          {!live && canDemoRemove && <span className="tag">precomputed</span>}
        </div>
        {canRemove ? (
          <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => onAction('remove')}>
            Remove {children.length ? `${object.label} and items on it` : object.label}
          </button>
        ) : (
          <LockedHint onUnlock={onUnlock} />
        )}
      </div>

      <div className="action">
        <div className="action-title">
          <Palette size={15} /> Recolor <span className="tag tag--ok">instant, in your browser</span>
        </div>
        <div className="swatches">
          {SWATCHES.map((s) => (
            <button
              key={s.hex}
              className="swatch"
              style={{ background: s.hex }}
              title={s.name}
              aria-label={`Recolor ${object.label} ${s.name}`}
              disabled={busy}
              onClick={() => onAction('recolor', s.hex, s.name)}
            />
          ))}
          <label className="swatch swatch--custom" title="Custom color">
            <input type="color" aria-label="Custom color" disabled={busy} onChange={(e) => onAction('recolor', e.target.value, e.target.value)} />
          </label>
        </div>
      </div>

      <div className="action">
        <div className="action-title">
          <Wand2 size={15} /> Restyle material
        </div>
        {live ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (restyle.trim()) onAction('restyle', restyle.trim())
            }}
          >
            <input placeholder={`e.g. ${RESTYLE_IDEAS[0]}`} value={restyle} onChange={(e) => setRestyle(e.target.value)} disabled={busy} />
            <button className="btn btn--outline btn--sm" disabled={busy || !restyle.trim()}>
              Apply
            </button>
            <div className="ideas">
              {RESTYLE_IDEAS.map((i) => (
                <button type="button" key={i} className="idea" onClick={() => setRestyle(i)}>
                  {i}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <LockedHint onUnlock={onUnlock} />
        )}
      </div>

      <div className="action">
        <div className="action-title">
          <Sofa size={15} /> Replace
        </div>
        {live ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (replace.trim()) onAction('replace', replace.trim())
            }}
          >
            <input placeholder={`e.g. a mid-century ${object.label}`} value={replace} onChange={(e) => setReplace(e.target.value)} disabled={busy} />
            <button className="btn btn--outline btn--sm" disabled={busy || !replace.trim()}>
              Apply
            </button>
            <div className="ideas">
              {REPLACE_IDEAS.map((i) => (
                <button type="button" key={i} className="idea" onClick={() => setReplace(`a ${i} ${object.label}`)}>
                  {i}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <LockedHint onUnlock={onUnlock} />
        )}
      </div>
    </div>
  )
}

function Swatches({ label, busy, onPick }) {
  return (
    <div className="swatches">
      {SWATCHES.map((s) => (
        <button key={s.hex} className="swatch" style={{ background: s.hex }} title={s.name} aria-label={`Recolor ${label} ${s.name}`} disabled={busy} onClick={() => onPick(s.hex, s.name)} />
      ))}
      <label className="swatch swatch--custom" title="Custom color">
        <input type="color" aria-label="Custom color" disabled={busy} onChange={(e) => onPick(e.target.value, e.target.value)} />
      </label>
    </div>
  )
}

// Several objects at once: one AI call removes them all (one charge instead of
// one per item); recolor applies the same color to each.
function MultiCard({ selected, live, canDemoRemove, onAction, onUnlock, onClear, busy }) {
  const names = selected.map((o) => o.label)
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <h3>{selected.length} items selected</h3>
        <span className="muted small">{names.join(', ')}</span>
      </div>
      <div className="action">
        <div className="action-title">
          <Eraser size={15} /> Remove all
          {live ? <span className="tag tag--ok">one AI call</span> : canDemoRemove && <span className="tag">precomputed</span>}
        </div>
        {live || canDemoRemove ? (
          <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => onAction('remove')}>
            Remove {selected.length} items
          </button>
        ) : (
          <LockedHint onUnlock={onUnlock} />
        )}
      </div>
      <div className="action">
        <div className="action-title">
          <Palette size={15} /> Recolor all <span className="tag tag--ok">instant, in your browser</span>
        </div>
        <Swatches label="selection" busy={busy} onPick={(hex, name) => onAction('recolor', hex, name)} />
      </div>
      <p className="muted small">Restyle and replace work on one item at a time.</p>
      <button className="btn btn--ghost btn--sm" onClick={onClear}>
        <X size={14} /> Clear selection
      </button>
    </div>
  )
}

export function EditTab({ photo, objects, selected, live, scanned, busy, multiSelect, onMultiSelect, onSelect, onAction, onScan, onUnlock }) {
  const selectedIds = selected.map((o) => o.id)
  const single = selected.length === 1 ? selected[0] : null
  return (
    <div className="tab-body">
      {objects.length > 0 ? (
        <>
          <div className="edit-head">
            <p className="muted small">Tap furniture in the photo, or pick it here. Shift-click to select several.</p>
            <button className={`chip chip--toggle ${multiSelect ? 'chip--on' : ''}`} aria-pressed={multiSelect} onClick={() => onMultiSelect(!multiSelect)}>
              <CopyCheck size={13} /> Select multiple
            </button>
          </div>
          <div className="obj-chips">
            {objects.map((o) => (
              <button
                key={o.id}
                className={`chip ${selectedIds.includes(o.id) ? 'chip--on' : ''}`}
                onClick={(e) => onSelect(o.id, multiSelect || e.shiftKey || e.metaKey || e.ctrlKey)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-note">
          {live ? (
            <p>{scanned ? 'No furniture found. Try scanning again or stage the room.' : 'Scan the photo to find tappable furniture.'}</p>
          ) : photo?.kind === 'upload' ? (
            <p>Scanning your own photos needs a Gemini key. The sample photos work without one.</p>
          ) : (
            <p>No precomputed objects for this photo.</p>
          )}
        </div>
      )}

      {live && (
        <button className="btn btn--outline btn--sm btn--full" disabled={busy} onClick={onScan}>
          {scanned ? <RefreshCw size={14} /> : <ScanSearch size={14} />} {scanned ? 'Rescan with Gemini' : 'Scan for furniture'}
        </button>
      )}
      {!live && photo?.kind === 'upload' && <LockedHint onUnlock={onUnlock} />}

      {single && (
        <ObjectCard
          key={single.id}
          object={single}
          objects={objects}
          live={live}
          canDemoRemove={Boolean(single.removal) && photo?.kind === 'sample'}
          onAction={onAction}
          onUnlock={onUnlock}
          busy={busy}
        />
      )}
      {selected.length > 1 && (
        <MultiCard
          selected={selected}
          live={live}
          canDemoRemove={photo?.kind === 'sample' && selected.every((o) => o.removal)}
          onAction={onAction}
          onUnlock={onUnlock}
          onClear={() => onSelect(null)}
          busy={busy}
        />
      )}
    </div>
  )
}

export function StageTab({ photo, live, busy, onStage, onUnlock, onRoomType }) {
  const [style, setStyle] = useState('scandinavian')
  const [isEmpty, setIsEmpty] = useState(null)
  const empty = isEmpty ?? Boolean(photo?.isEmpty)
  return (
    <div className="tab-body">
      <p className="muted small">
        Whole-room staging can't be masked, so a vision model checks the result for changed walls, windows, or floors and regenerates once if it finds any.
      </p>
      <label className="field">
        <span>Room type {photo?.detected && <span className="tag tag--ok">detected</span>}</span>
        <select value={photo?.roomType || 'living-room'} onChange={(e) => onRoomType(e.target.value)} disabled={busy}>
          {ROOM_TYPES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={empty} onChange={(e) => setIsEmpty(e.target.checked)} disabled={busy} />
        Room is empty (otherwise existing furniture is replaced)
      </label>
      <div className="styles">
        {STYLE_IDS.map((id) => (
          <button key={id} className={`style-card ${style === id ? 'style-card--on' : ''}`} onClick={() => setStyle(id)} disabled={busy}>
            <span className="style-swatch">
              {STYLES[id].swatch.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            {STYLES[id].label}
          </button>
        ))}
      </div>
      {live ? (
        <button className="btn btn--primary btn--full" disabled={busy} onClick={() => onStage({ style, isEmpty: empty })}>
          <Sparkles size={16} /> Stage this room
        </button>
      ) : (
        <LockedHint onUnlock={onUnlock} />
      )}
    </div>
  )
}

export function HistoryTab({ steps, cursor, onGoto }) {
  return (
    <div className="tab-body">
      <div className="history-actions">
        <button className="btn btn--ghost btn--sm" disabled={cursor <= 0} onClick={() => onGoto(cursor - 1)}>
          <Undo2 size={14} /> Undo
        </button>
        <button className="btn btn--ghost btn--sm" disabled={cursor >= steps.length - 1} onClick={() => onGoto(cursor + 1)}>
          <Redo2 size={14} /> Redo
        </button>
      </div>
      <ol className="history">
        {steps.map((s, i) => (
          <li key={s.id} className={`${i === cursor ? 'is-current' : ''} ${i > cursor ? 'is-future' : ''}`}>
            <button onClick={() => onGoto(i)}>
              <img src={s.url} alt="" />
              <span>
                <strong>{s.label}</strong>
                {(s.engine || s.note) && <em>{[s.engine, s.note].filter(Boolean).join(' · ')}</em>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
