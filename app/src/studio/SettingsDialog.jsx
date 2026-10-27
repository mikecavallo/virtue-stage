import { useState } from 'react'
import { AlertTriangle, KeyRound, ShieldCheck } from 'lucide-react'
import Modal from '../components/Modal.jsx'
import { IMAGE_MODEL_OPTIONS, VISION_MODEL_OPTIONS, listModels } from '../ai/gemini.js'

// `prompt` is set when a live request failed because of the key (expired,
// invalid, no model access): { reason, clearKey, canRetry }.
export default function SettingsDialog({ settings, onSave, onClose, prompt = null }) {
  const [draft, setDraft] = useState(() => (prompt?.clearKey ? { ...settings, apiKey: '' } : settings))
  const [test, setTest] = useState(null)
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))

  const runTest = async () => {
    setTest({ state: 'running' })
    try {
      const models = await listModels({ apiKey: draft.apiKey.trim() })
      const missing = [draft.imageModel, draft.visionModel].filter((m) => !models.includes(m))
      setTest(
        missing.length
          ? { state: 'warn', text: `Key works, but it can't see ${missing.join(' and ')}. Pick another model below.` }
          : { state: 'ok', text: 'Key works and both models are available.' },
      )
    } catch (e) {
      setTest({ state: 'error', text: e.message })
    }
  }

  return (
    <Modal
      title={prompt ? 'Gemini API key needed' : 'Live AI settings'}
      onClose={onClose}
      footer={
        <>
          {settings.apiKey && (
            <button className="btn btn--ghost" onClick={() => onSave({ ...draft, apiKey: '', remember: false })}>
              {prompt ? 'Use demo mode' : 'Remove key'}
            </button>
          )}
          <button className="btn btn--primary" disabled={Boolean(prompt) && !draft.apiKey.trim()} onClick={() => onSave({ ...draft, apiKey: draft.apiKey.trim() })}>
            {prompt?.canRetry ? 'Save and retry' : 'Save'}
          </button>
        </>
      }
    >
      {prompt && (
        <div className="key-alert" role="alert">
          <AlertTriangle size={16} />
          <p>{prompt.reason}</p>
        </div>
      )}
      <p className="muted">
        Without a key the studio runs in demo mode on the sample photos. Add your own{' '}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Gemini API key
        </a>{' '}
        to scan, edit, and stage any photo. Image models need a key with billing enabled (about $0.05 per 2K edit).
      </p>

      <label className="field">
        <span>
          <KeyRound size={14} /> Gemini API key
        </span>
        <div className="field-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck="false"
            placeholder="AIza..."
            value={draft.apiKey}
            onChange={(e) => {
              set({ apiKey: e.target.value })
              setTest(null)
            }}
          />
          <button className="btn btn--outline btn--sm" disabled={!draft.apiKey.trim() || test?.state === 'running'} onClick={runTest}>
            {test?.state === 'running' ? 'Testing' : 'Test'}
          </button>
        </div>
      </label>
      {test && test.state !== 'running' && <p className={`test-result test-result--${test.state}`}>{test.text}</p>}

      <label className="check">
        <input type="checkbox" checked={draft.remember} onChange={(e) => set({ remember: e.target.checked })} />
        Remember the key on this device
      </label>

      <p className="privacy">
        <ShieldCheck size={14} /> The key stays in this browser. Requests go straight from your browser to Google; there is no VirtueStage server.
      </p>

      <div className="field-grid">
        <label className="field">
          <span>Image model</span>
          <select value={draft.imageModel} onChange={(e) => set({ imageModel: e.target.value })}>
            {IMAGE_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Vision model</span>
          <select value={draft.visionModel} onChange={(e) => set({ visionModel: e.target.value })}>
            {VISION_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Output size</span>
          <select value={draft.imageSize} onChange={(e) => set({ imageSize: e.target.value })}>
            <option value="1K">1K (cheaper)</option>
            <option value="2K">2K (recommended)</option>
            <option value="4K">4K</option>
          </select>
        </label>
      </div>
    </Modal>
  )
}
