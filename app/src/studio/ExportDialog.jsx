import { useState } from 'react'
import { Download, FileText, Scale } from 'lucide-react'
import Modal from '../components/Modal.jsx'

export default function ExportDialog({ disclosure, log, onDownload, onDownloadOriginal, onClose }) {
  const [label, setLabel] = useState(Boolean(disclosure))
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(log)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal title="Export" onClose={onClose}>
      <div className="export-note">
        <Scale size={16} />
        <p>
          California's AB 723 (in force since Jan 1, 2026) requires a visible disclosure on digitally altered listing photos and a link to the
          unaltered original. VirtueStage stamps the label for you; post the original alongside it.
        </p>
      </div>
      <label className="check">
        <input type="checkbox" checked={label} disabled={!disclosure} onChange={(e) => setLabel(e.target.checked)} />
        Stamp “{disclosure || 'No edits yet'}” on the photo
      </label>
      <div className="export-actions">
        <button className="btn btn--primary" onClick={() => onDownload(label ? disclosure : '')}>
          <Download size={16} /> Edited photo
        </button>
        <button className="btn btn--outline" onClick={onDownloadOriginal}>
          <Download size={16} /> Original
        </button>
        <button className="btn btn--ghost" onClick={copy}>
          <FileText size={16} /> {copied ? 'Copied' : 'Copy change log'}
        </button>
      </div>
      <pre className="changelog">{log}</pre>
    </Modal>
  )
}
