import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Download, FlaskConical, Upload, Zap, Columns2, Undo2, Redo2, Sparkles } from 'lucide-react'
import { Wordmark } from '../components/Logo.jsx'
import Editor from '../studio/Editor.jsx'
import { EditTab, HistoryTab, StageTab } from '../studio/Inspector.jsx'
import SettingsDialog from '../studio/SettingsDialog.jsx'
import ExportDialog from '../studio/ExportDialog.jsx'
import { initialState, reducer, renderOps, replayBaseIndex, withoutRemoved, disclosureText, changeLog, editedRegions, polishProtect } from '../studio/history.js'
import { SAMPLES, sampleBase, sampleImage, loadInventory } from '../lib/samples.js'
import { loadSettings, saveSettings } from '../lib/settings.js'
import { canvasToBase64, canvasToBlob, imageToCanvas, loadImage, stampDisclosure } from '../lib/canvas.js'
import { describeItems, fitWithin, slugify, topLevel, withDescendants } from '../lib/geometry.js'
import { detectRoom, segmentObjects } from '../ai/tasks.js'
import { runObjectEdit, runPolish, runStaging } from '../ai/pipeline.js'
import { STYLES } from '../ai/prompts.js'
import { GeminiError, isKeyError, listModels } from '../ai/gemini.js'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
let stepCounter = 0

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function qaNote(qa) {
  if (!qa) return ''
  if (qa.preserved === true) return qa.attempts > 1 ? 'architecture check passed on retry' : 'architecture check passed'
  if (qa.preserved === false) return `architecture check flagged: ${qa.issues.join('; ')}`
  return 'architecture check unavailable'
}

export default function Studio({ initialSample }) {
  const [settings, setSettings] = useState(loadSettings)
  const live = Boolean(settings.apiKey)
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tab, setTab] = useState('edit')
  const [dialog, setDialog] = useState(null)
  // Compare against the step right before this one (default) or the original.
  const [compare, setCompare] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [showOutlines, setShowOutlines] = useState(true)
  const [keyPrompt, setKeyPrompt] = useState(null)
  const retryRef = useRef(null)

  const canvases = useRef(new Map())
  const objectUrls = useRef([])
  const abortRef = useRef(null)
  const fileRef = useRef(null)
  const stateRef = useRef(state)
  const settingsRef = useRef(settings)
  useEffect(() => {
    stateRef.current = state
    settingsRef.current = settings
  })

  const { photo, steps, cursor } = state
  const step = steps[cursor]
  const objects = step?.objects || []
  const selected = objects.filter((o) => state.selectedIds.includes(o.id))
  const busy = Boolean(state.busy)
  const regions = editedRegions(steps, cursor)

  const resetPhoto = () => {
    abortRef.current?.abort()
    objectUrls.current.forEach((u) => URL.revokeObjectURL(u))
    objectUrls.current = []
    canvases.current.clear()
  }

  const makeStep = async (canvas, fields) => {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92)
    const url = URL.createObjectURL(blob)
    objectUrls.current.push(url)
    const id = `step-${++stepCounter}`
    canvases.current.set(id, canvas)
    return { id, url, ...fields }
  }

  const loadSample = useCallback(async (id) => {
    const sample = SAMPLES.find((s) => s.id === id) || SAMPLES[0]
    dispatch({ type: 'busy', label: 'Loading photo' })
    try {
      const [img, inv] = await Promise.all([loadImage(sampleImage(sample.id)), loadInventory(sample.id)])
      const canvas = imageToCanvas(img)
      resetPhoto()
      const sid = `step-${++stepCounter}`
      canvases.current.set(sid, canvas)
      dispatch({
        type: 'load',
        photo: {
          kind: 'sample',
          sampleId: sample.id,
          name: sample.title,
          width: canvas.width,
          height: canvas.height,
          roomType: sample.roomType,
          isEmpty: false,
          patchBaseUrl: sampleBase(sample.id),
          sourceWidth: inv?.width || canvas.width,
          sourceHeight: inv?.height || canvas.height,
        },
        step: {
          id: sid,
          url: sampleImage(sample.id),
          label: 'Original photo',
          engine: inv ? 'objects precomputed offline' : '',
          objects: inv?.objects || [],
          scanned: Boolean(inv),
          op: { type: 'original' },
        },
      })
    } catch (e) {
      dispatch({ type: 'error', message: e.message })
    }
  }, [])

  useEffect(() => {
    loadSample(initialSample)
  }, [initialSample, loadSample])

  const pickSample = (id) => {
    window.history.replaceState(null, '', `#/studio/${id}`)
    setCompare(false)
    loadSample(id)
  }

  // ── Live AI helpers ──
  const scanCanvas = async (canvas, { withRoom = false } = {}) => {
    const s = settingsRef.current
    const image = canvasToBase64(canvas)
    dispatch({ type: 'busy', label: withRoom ? `Detecting room and furniture with ${s.visionModel}` : `Scanning furniture with ${s.visionModel}` })
    const [objs, room] = await Promise.allSettled([
      segmentObjects({ apiKey: s.apiKey, model: s.visionModel, image }),
      withRoom ? detectRoom({ apiKey: s.apiKey, model: s.visionModel, image }) : Promise.resolve(null),
    ])
    if (room.status === 'fulfilled' && room.value) {
      dispatch({ type: 'photo-meta', patch: { roomType: room.value.roomType, isEmpty: room.value.isEmpty, detected: true, summary: room.value.summary } })
    }
    if (objs.status === 'fulfilled') {
      dispatch({ type: 'set-objects', objects: objs.value })
      dispatch({ type: 'idle' })
    } else {
      failAi(objs.reason || new Error('Scan failed'), () => scanCanvas(canvas, { withRoom }))
    }
  }

  const onScan = async () => {
    const st = stateRef.current
    await scanCanvas(canvases.current.get(st.steps[st.cursor].id))
  }

  const onUpload = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return dispatch({ type: 'error', message: 'That file is not an image.' })
    if (file.size > MAX_UPLOAD_BYTES) return dispatch({ type: 'error', message: 'Please use a photo under 25 MB.' })
    dispatch({ type: 'busy', label: 'Loading photo' })
    try {
      const tmp = URL.createObjectURL(file)
      const img = await loadImage(tmp)
      URL.revokeObjectURL(tmp)
      const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, 2048)
      const canvas = imageToCanvas(img, width, height)
      resetPhoto()
      const first = await makeStep(canvas, { label: 'Original photo', objects: [], scanned: false, op: { type: 'original' } })
      window.history.replaceState(null, '', '#/studio')
      setCompare(false)
      dispatch({ type: 'load', photo: { kind: 'upload', name: file.name.replace(/\.[^.]+$/, ''), width, height, roomType: 'living-room', isEmpty: false }, step: first })
      if (settingsRef.current.apiKey) await scanCanvas(canvas, { withRoom: true })
    } catch (e) {
      dispatch({ type: 'error', message: e.message })
    }
  }

  // A key problem (expired, invalid, no model access) opens the key prompt
  // instead of a dead-end error. Saving a new key retries the failed action.
  const failAi = (error, retry) => {
    if (!isKeyError(error)) return dispatch({ type: 'error', message: error.message })
    retryRef.current = retry || null
    dispatch({ type: 'idle' })
    setKeyPrompt({ reason: error.message, clearKey: error.code === 'bad_key' || error.code === 'expired_key', canRetry: Boolean(retry) })
    setDialog('settings')
  }

  // Settings are read at run time (not captured), so a retry uses the new key.
  const runGenerative = async (busyLabel, work, describe, after) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    dispatch({ type: 'busy', label: busyLabel })
    try {
      const result = await work(ac.signal, (label) => dispatch({ type: 'busy', label }))
      const next = await makeStep(result.canvas, describe(result))
      dispatch({ type: 'push', step: next })
      if (after) await after(result, next)
    } catch (e) {
      if (e?.name === 'AbortError') dispatch({ type: 'idle' })
      else failAi(e, () => runGenerative(busyLabel, work, describe, after))
    }
  }

  const applyReplayable = async (op, label, engine) => {
    const st = stateRef.current
    const baseIdx = replayBaseIndex(st.steps, st.cursor)
    const base = st.steps[baseIdx]
    const ops = [...st.steps.slice(baseIdx + 1, st.cursor + 1).map((s) => s.op), op]
    dispatch({ type: 'busy', label })
    try {
      const { canvas, removed } = await renderOps({
        base: canvases.current.get(base.id),
        objects: base.objects,
        ops,
        patchBaseUrl: st.photo.patchBaseUrl,
        sourceWidth: st.photo.sourceWidth,
        sourceHeight: st.photo.sourceHeight,
      })
      const next = await makeStep(canvas, { label, engine, objects: withoutRemoved(base.objects, [...removed]), scanned: base.scanned, op })
      dispatch({ type: 'push', step: next })
    } catch (e) {
      dispatch({ type: 'error', message: e.message })
    }
  }

  // Acts on the whole selection: remove and recolor accept several objects
  // (one model call for a multi-remove); restyle and replace take one.
  const onAction = async (action, value, name) => {
    const st = stateRef.current
    const cur = st.steps[st.cursor]
    const picked = cur.objects.filter((o) => st.selectedIds.includes(o.id))
    if (!picked.length) return
    const obj = picked[0]
    const ids = picked.map((o) => o.id)
    const what = new Set(picked.map((o) => o.label)).size > 3 ? `${picked.length} items` : describeItems(picked.map((o) => o.label))
    if (action === 'recolor') {
      return applyReplayable({ type: 'recolor', objectIds: ids, hex: value }, `Recolored ${what} ${String(name).toLowerCase()}`, 'in-browser recolor')
    }
    if (action === 'remove' && !settingsRef.current.apiKey) {
      const polygons = topLevel(cur.objects, ids).flatMap((id) => withDescendants(cur.objects, id).map((o) => o.mask))
      return applyReplayable({ type: 'demo-remove', objectIds: ids, polygons }, `Removed ${what}`, 'LaMa, precomputed')
    }
    if (action !== 'remove' && picked.length > 1) return
    const verb = { remove: 'Removing', restyle: 'Restyling', replace: 'Replacing' }[action]
    await runGenerative(
      `${verb} ${picked.length > 1 ? what : `the ${obj.label}`}`,
      (signal, onStatus) =>
        runObjectEdit({ settings: settingsRef.current, canvas: canvases.current.get(cur.id), objects: cur.objects, object: obj, objectIds: ids, action, instruction: value, onStatus, signal }),
      (res) => ({
        label: action === 'remove' ? `Removed ${what}` : action === 'restyle' ? `Restyled ${obj.label}: ${value}` : `Replaced ${obj.label} with ${value}`,
        engine: settingsRef.current.imageModel,
        note: [picked.length > 1 ? 'one AI call' : '', res.attempts > 1 ? 'regenerated once (model shifted the photo)' : ''].filter(Boolean).join(', '),
        objects: action === 'replace' ? cur.objects.map((o) => (o.id === obj.id ? { ...o, label: value.replace(/^an? /, '') } : o)) : withoutRemoved(cur.objects, res.removedIds),
        scanned: cur.scanned,
        op: { type: action, polygons: res.polygons },
      }),
    )
  }

  const onStage = async ({ style, isEmpty }) => {
    const st = stateRef.current
    const cur = st.steps[st.cursor]
    await runGenerative(
      `Staging: ${STYLES[style].label}`,
      (signal, onStatus) => runStaging({ settings: settingsRef.current, canvas: canvases.current.get(cur.id), roomType: st.photo.roomType, style, isEmpty, onStatus, signal }),
      (res) => ({ label: `Staged: ${STYLES[style].label}`, engine: settingsRef.current.imageModel, note: qaNote(res.qa), objects: [], scanned: false, op: { type: 'stage', style } }),
      async (result) => {
        setTab('edit')
        await scanCanvas(result.canvas)
      },
    )
  }

  const onPolish = async () => {
    if (!settingsRef.current.apiKey) {
      return failAi(new GeminiError('Polish sends your edited areas to Gemini for cleanup. Add your key to use it.', { code: 'no_key' }), onPolish)
    }
    const st = stateRef.current
    const cur = st.steps[st.cursor]
    const polygons = editedRegions(st.steps, st.cursor)
    if (!polygons.length) return
    const protect = polishProtect(cur.objects, polygons)
    await runGenerative(
      'Polishing edits',
      (signal, onStatus) => runPolish({ settings: settingsRef.current, canvas: canvases.current.get(cur.id), polygons, protect, onStatus, signal }),
      (res) => ({
        label: 'Polished the edited areas',
        engine: settingsRef.current.imageModel,
        note: res.attempts > 1 ? 'regenerated once (model shifted the photo)' : 'cleanup pasted back inside edited areas',
        objects: cur.objects,
        scanned: cur.scanned,
        op: { type: 'polish' },
      }),
    )
  }

  const onSelect = (id, additive = false) => {
    dispatch({ type: 'select', id, additive })
    if (id) {
      setTab('edit')
      setCompare(false)
    }
  }

  const goto = (i) => dispatch({ type: 'goto', index: i })

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select')) return
      const st = stateRef.current
      if (st.busy) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: 'goto', index: st.cursor + (e.shiftKey ? 1 : -1) })
      } else if (e.key === 'Escape') {
        dispatch({ type: 'select', id: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => () => resetPhoto(), [])

  const download = async (label) => {
    const st = stateRef.current
    const c = canvases.current.get(st.steps[st.cursor].id)
    const out = label ? stampDisclosure(c, label) : c
    triggerDownload(await canvasToBlob(out, 'image/jpeg', 0.92), `${slugify(st.photo.name)}-virtuestage.jpg`)
  }

  const downloadOriginal = async () => {
    const st = stateRef.current
    triggerDownload(await canvasToBlob(canvases.current.get(st.steps[0].id), 'image/jpeg', 0.95), `${slugify(st.photo.name)}-original.jpg`)
  }

  const saveAndClose = (next) => {
    saveSettings(next)
    setSettings(next)
    settingsRef.current = next
    setDialog(null)
    setKeyPrompt(null)
    const retry = retryRef.current
    retryRef.current = null
    if (retry && next.apiKey) retry()
  }

  const closeDialog = () => {
    if (keyPrompt && retryRef.current) dispatch({ type: 'error', message: 'Live AI is paused until a working Gemini key is added.' })
    retryRef.current = null
    setKeyPrompt(null)
    setDialog(null)
  }

  // Catch an expired or revoked key on arrival, before the user spends time on an edit.
  // Listing models is free, and network failures here are ignored.
  useEffect(() => {
    const key = settingsRef.current.apiKey
    if (!key) return
    const ac = new AbortController()
    listModels({ apiKey: key, signal: ac.signal }).catch((e) => {
      if (!isKeyError(e)) return
      setKeyPrompt({ reason: e.message, clearKey: e.code !== 'forbidden', canRetry: false })
      setDialog('settings')
    })
    return () => ac.abort()
  }, [])

  return (
    <div className="studio">
      <header className="studio-bar">
        <Wordmark />
        <div className="studio-bar-right">
          <button className={`mode ${live ? 'mode--live' : ''}`} onClick={() => setDialog('settings')}>
            {live ? <Zap size={14} /> : <FlaskConical size={14} />}
            {live ? 'Live: Gemini' : 'Demo mode'}
          </button>
          <button className="btn btn--primary btn--sm" disabled={!step || busy} onClick={() => setDialog('export')}>
            <Download size={15} /> Export
          </button>
        </div>
      </header>

      <nav className="photo-strip" aria-label="Photos">
        {SAMPLES.map((s) => (
          <button key={s.id} className={`thumb ${photo?.sampleId === s.id ? 'thumb--on' : ''}`} disabled={busy} onClick={() => pickSample(s.id)}>
            <img src={sampleImage(s.id)} alt="" loading="lazy" />
            <span>{s.title}</span>
          </button>
        ))}
        <button className={`thumb thumb--upload ${photo?.kind === 'upload' ? 'thumb--on' : ''}`} disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={20} />
          <span>Your photo</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            onUpload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </nav>

      {!live && (
        <div className="demo-banner">
          <FlaskConical size={16} />
          <p>
            <strong>Demo mode.</strong> Furniture outlines and removals on the sample photos were computed offline with open-source models. Recolor runs live in your browser.{' '}
            <button className="link" onClick={() => setDialog('settings')}>
              Add a Gemini key
            </button>{' '}
            to scan, edit, and stage any photo.
          </p>
        </div>
      )}

      <main className="studio-main">
        <section className="canvas-area">
          <Editor
            photo={photo}
            url={step?.url}
            compareUrl={compare === 'original' ? steps[0]?.url : steps[cursor - 1]?.url}
            compareLabel={compare === 'original' ? 'Original' : 'Before'}
            objects={objects}
            selectedIds={state.selectedIds}
            multiSelect={multiSelect}
            onSelect={onSelect}
            busy={state.busy}
            compare={Boolean(compare)}
            showOutlines={showOutlines}
          />
          <div className="editor-tools">
            <label className="toggle">
              <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
              Outlines
            </label>
            <button className={`btn btn--ghost btn--sm ${compare ? 'is-on' : ''}`} disabled={cursor < 1} onClick={() => setCompare((c) => (c ? false : 'previous'))}>
              <Columns2 size={15} /> {compare ? 'Back to editing' : 'Compare'}
            </button>
            {compare && cursor > 1 && (
              <div className="segmented" role="group" aria-label="Compare against">
                <button className={compare === 'previous' ? 'is-on' : ''} onClick={() => setCompare('previous')}>
                  Last step
                </button>
                <button className={compare === 'original' ? 'is-on' : ''} onClick={() => setCompare('original')}>
                  Original
                </button>
              </div>
            )}
            <button
              className="btn btn--outline btn--sm polish-btn"
              disabled={busy || !regions.length}
              onClick={onPolish}
              title={regions.length ? 'Clean up leftover shadows, smudges, and outlines around your edits' : 'Remove or replace something first'}
            >
              <Sparkles size={15} /> Polish
            </button>
            <span className="spacer" />
            <button className="icon-btn" disabled={busy || cursor <= 0} onClick={() => goto(cursor - 1)} aria-label="Undo">
              <Undo2 size={17} />
            </button>
            <button className="icon-btn" disabled={busy || cursor >= steps.length - 1} onClick={() => goto(cursor + 1)} aria-label="Redo">
              <Redo2 size={17} />
            </button>
          </div>
          {photo?.summary && <p className="muted small room-summary">{photo.summary}</p>}
        </section>

        <aside className="inspector">
          <div className="tabs" role="tablist">
            {[
              ['edit', 'Edit'],
              ['stage', 'Stage'],
              ['history', `History${steps.length > 1 ? ` (${steps.length - 1})` : ''}`],
            ].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'tab--on' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'edit' && (
            <EditTab
              photo={photo}
              objects={objects}
              selected={selected}
              live={live}
              scanned={Boolean(step?.scanned)}
              busy={busy}
              multiSelect={multiSelect}
              onMultiSelect={setMultiSelect}
              onSelect={onSelect}
              onAction={onAction}
              onScan={onScan}
              onUnlock={() => setDialog('settings')}
            />
          )}
          {tab === 'stage' && (
            <StageTab
              key={photo?.name}
              photo={photo}
              live={live}
              busy={busy}
              onStage={onStage}
              onUnlock={() => setDialog('settings')}
              onRoomType={(roomType) => dispatch({ type: 'photo-meta', patch: { roomType, detected: false } })}
            />
          )}
          {tab === 'history' && <HistoryTab steps={steps} cursor={cursor} onGoto={goto} />}
        </aside>
      </main>

      {state.error && (
        <div className="toast toast--error" role="alert">
          <p>{state.error}</p>
          <button className="icon-btn" onClick={() => dispatch({ type: 'dismiss' })} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {dialog === 'settings' && (
        <SettingsDialog key={keyPrompt ? 'key-prompt' : 'settings'} settings={settings} prompt={keyPrompt} onSave={saveAndClose} onClose={closeDialog} />
      )}
      {dialog === 'export' && (
        <ExportDialog
          disclosure={disclosureText(steps, cursor)}
          log={changeLog(photo, steps, cursor)}
          onDownload={download}
          onDownloadOriginal={downloadOriginal}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

