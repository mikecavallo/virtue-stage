import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../auth'

const ROOM_TYPES = [
  { id: 'auto', label: 'Auto-Detect ✨', icon: '🔮' },
  { id: 'living-room', label: 'Living Room', icon: '🛋️' },
  { id: 'bedroom', label: 'Bedroom', icon: '🛏️' },
  { id: 'kitchen', label: 'Kitchen', icon: '🍳' },
  { id: 'dining-room', label: 'Dining Room', icon: '🍽️' },
  { id: 'bathroom', label: 'Bathroom', icon: '🚿' },
  { id: 'office', label: 'Office', icon: '💼' },
]

const STYLES = [
  { id: 'modern', label: 'Modern', desc: 'Clean lines, neutral tones', gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)' },
  { id: 'traditional', label: 'Traditional', desc: 'Classic & elegant', gradient: 'linear-gradient(135deg, #d97706, #b45309)' },
  { id: 'minimalist', label: 'Minimalist', desc: 'Less is more', gradient: 'linear-gradient(135deg, #64748b, #475569)' },
  { id: 'scandinavian', label: 'Scandinavian', desc: 'Light & cozy', gradient: 'linear-gradient(135deg, #0ea5e9, #06b6d4)' },
  { id: 'luxury', label: 'Luxury', desc: 'High-end finishes', gradient: 'linear-gradient(135deg, #a855f7, #7c3aed)' },
  { id: 'bohemian', label: 'Bohemian', desc: 'Eclectic & vibrant', gradient: 'linear-gradient(135deg, #f43f5e, #e11d48)' },
]

const PROCESSING_STEPS = [
  { label: 'Uploading image...', time: 0 },
  { label: 'Analyzing room layout...', time: 3 },
  { label: 'Selecting furniture & decor...', time: 8 },
  { label: 'Rendering staged room...', time: 15 },
  { label: 'Finishing touches...', time: 40 },
]

/* ─── Logo ─── */
function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="6" fill="#f59e0b"/>
      <path d="M8 20V8l6 12 6-12v12" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

/* ─── Photo Quality Tips ─── */
function PhotoTips() {
  return (
    <div className="photo-tips">
      <span className="photo-tips-icon">📸</span>
      <span className="photo-tips-text">
        <strong>For best results:</strong> Upload clear, well-lit photos. Natural daylight works best. Higher resolution = better staging.
      </span>
    </div>
  )
}

/* ─── Before/After Slider ─── */
function CompareSlider({ before, after, height }) {
  const containerRef = useRef(null)
  const [pos, setPos] = useState(50)
  const dragging = useRef(false)

  const update = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    setPos((x / rect.width) * 100)
  }, [])

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return
      e.preventDefault()
      update(e.touches ? e.touches[0].clientX : e.clientX)
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  }, [update])

  const startDrag = (e) => {
    dragging.current = true
    update(e.touches ? e.touches[0].clientX : e.clientX)
  }

  return (
    <div
      ref={containerRef}
      className="compare-slider"
      style={height ? { height, aspectRatio: 'unset' } : {}}
      onMouseDown={startDrag}
      onTouchStart={startDrag}
    >
      <img src={after} alt="After staging" className="compare-img" draggable={false} />
      <div className="compare-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={before} alt="Before staging" className="compare-img" draggable={false} />
      </div>
      <span className="compare-tag compare-tag--before">Before</span>
      <span className="compare-tag compare-tag--after">After</span>
      <div className="compare-handle" style={{ left: `${pos}%` }}>
        <div className="compare-handle-line" />
        <div className="compare-handle-knob">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M7 4l-5 6 5 6M13 4l5 6-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      </div>
    </div>
  )
}

/* ─── Room type display helper ─── */
function roomTypeLabel(rt) {
  const found = ROOM_TYPES.find(r => r.id === rt)
  return found ? found.label : rt
}

export default function DashboardPage({ onLanding }) {
  const { user, token, logout } = useAuth()
  const [jobs, setJobs] = useState([])
  const [credits, setCredits] = useState(null)
  const [view, setView] = useState('dashboard')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [imgDimensions, setImgDimensions] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [roomType, setRoomType] = useState('auto')
  const [style, setStyle] = useState('modern')
  const [uploading, setUploading] = useState(false)
  const [currentJob, setCurrentJob] = useState(null)
  const [jobResults, setJobResults] = useState(null)
  const [error, setError] = useState('')
  const [processingTime, setProcessingTime] = useState(0)
  const [detectedRoomType, setDetectedRoomType] = useState(null)
  const [stagingMode, setStagingMode] = useState(null)

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => setStagingMode(d.stagingMode)).catch(() => {})
  }, [])

  // Project flow state
  const [projects, setProjects] = useState([])
  const [projectView, setProjectView] = useState(null) // null | 'create-hero' | 'configure-hero' | 'processing-hero' | 'hero-done' | 'batch-upload' | 'processing-batch' | 'project-gallery'
  const [projectName, setProjectName] = useState('')
  const [currentProject, setCurrentProject] = useState(null)
  const [batchFiles, setBatchFiles] = useState([])
  const [batchPreviews, setBatchPreviews] = useState([])
  const [batchDragOver, setBatchDragOver] = useState(false)

  // Fetch jobs, credits, projects
  useEffect(() => {
    if (!token) return
    fetch('/api/staging/jobs', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { jobs: [] })
      .then(d => setJobs(d.jobs || []))
      .catch(() => {})
    fetch('/api/credits', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setCredits(d.credits))
      .catch(() => {})
    fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(d => setProjects(d.projects || []))
      .catch(() => {})
  }, [token, view, projectView])

  // Poll single-image processing
  useEffect(() => {
    if (!currentJob || view !== 'processing') return
    const start = Date.now()
    const timer = setInterval(() => setProcessingTime(Math.floor((Date.now() - start) / 1000)), 1000)
    const poller = setInterval(async () => {
      try {
        const r = await fetch(`/api/staging/status/${currentJob}`, { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        if (d.status === 'complete') {
          clearInterval(poller); clearInterval(timer)
          if (d.roomType && d.autoDetected) setDetectedRoomType(d.roomType)
          const rr = await fetch(`/api/staging/results/${currentJob}`, { headers: { Authorization: `Bearer ${token}` } })
          const rd = await rr.json()
          if (rd.autoDetected && rd.roomType) setDetectedRoomType(rd.roomType)
          setJobResults(rd)
          setView('results')
        } else if (d.status === 'error') {
          clearInterval(poller); clearInterval(timer)
          setError(d.error || 'Processing failed')
          setView('dashboard')
        }
      } catch { /* transient network error: keep polling */ }
    }, 2000)
    return () => { clearInterval(poller); clearInterval(timer) }
  }, [currentJob, view, token])

  // Poll project hero processing
  useEffect(() => {
    if (!currentProject || projectView !== 'processing-hero') return
    const start = Date.now()
    const timer = setInterval(() => setProcessingTime(Math.floor((Date.now() - start) / 1000)), 1000)
    const poller = setInterval(async () => {
      try {
        const r = await fetch(`/api/projects/${currentProject.id}`, { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        const heroJob = d.project?.jobs?.[0] || d.jobs?.[0]
        if (heroJob?.status === 'complete') {
          clearInterval(poller); clearInterval(timer)
          setCurrentProject(d.project || d)
          setProjectView('hero-done')
        } else if (heroJob?.status === 'error') {
          clearInterval(poller); clearInterval(timer)
          setError(heroJob.error || 'Hero processing failed')
          setProjectView(null)
          setView('dashboard')
        }
      } catch { /* transient network error: keep polling */ }
    }, 2000)
    return () => { clearInterval(poller); clearInterval(timer) }
  }, [currentProject, projectView, token])

  // Poll batch processing
  useEffect(() => {
    if (!currentProject || projectView !== 'processing-batch') return
    const start = Date.now()
    const timer = setInterval(() => setProcessingTime(Math.floor((Date.now() - start) / 1000)), 1000)
    const poller = setInterval(async () => {
      try {
        const r = await fetch(`/api/projects/${currentProject.id}`, { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        const proj = d.project || d
        const allJobs = proj.jobs || []
        const allDone = allJobs.length > 0 && allJobs.every(j => j.status === 'complete' || j.status === 'error')
        if (allDone) {
          clearInterval(poller); clearInterval(timer)
          setCurrentProject(proj)
          setProjectView('project-gallery')
        }
      } catch { /* transient network error: keep polling */ }
    }, 2000)
    return () => { clearInterval(poller); clearInterval(timer) }
  }, [currentProject, projectView, token])

  function handleFile(f) {
    if (!f) return
    setFile(f)
    const url = URL.createObjectURL(f)
    setPreview(url)
    const img = new Image()
    img.onload = () => setImgDimensions({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = url
    setDetectedRoomType(null)
    if (projectView === 'create-hero') {
      setProjectView('configure-hero')
    } else {
      setView('configure')
    }
    setError('')
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer?.files?.[0]
    if (f && f.type.startsWith('image/')) handleFile(f)
  }

  async function handleGenerate() {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('style', style)
      fd.append('room_type', roomType)
      fd.append('room_0', file)
      const r = await fetch('/api/staging/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      setCurrentJob(d.jobId)
      if (d.autoDetected && d.roomType) setDetectedRoomType(d.roomType)
      setProcessingTime(0)
      setView('processing')
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleCreateProject() {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('hero_image', file)
      fd.append('style', style)
      fd.append('room_type', roomType)
      fd.append('name', projectName || 'Untitled Project')
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Project creation failed')
      setCurrentProject(d.project || d)
      setProcessingTime(0)
      setProjectView('processing-hero')
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  function handleBatchDrop(e) {
    e.preventDefault()
    setBatchDragOver(false)
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/')).slice(0, 10)
    addBatchFiles(files)
  }

  function addBatchFiles(files) {
    const newFiles = [...batchFiles, ...files].slice(0, 10)
    setBatchFiles(newFiles)
    setBatchPreviews(newFiles.map(f => URL.createObjectURL(f)))
  }

  function removeBatchFile(idx) {
    const nf = batchFiles.filter((_, i) => i !== idx)
    setBatchFiles(nf)
    setBatchPreviews(nf.map(f => URL.createObjectURL(f)))
  }

  async function handleBatchUpload() {
    if (!batchFiles.length || !currentProject) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      batchFiles.forEach(f => fd.append('images', f))
      const r = await fetch(`/api/projects/${currentProject.id}/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Batch upload failed')
      setProcessingTime(0)
      setProjectView('processing-batch')
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleRestage(jobId, newStyle) {
    setError('')
    try {
      const r = await fetch(`/api/staging/restage/${jobId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: newStyle })
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Restage failed')
      setCurrentJob(d.jobId)
      setProcessingTime(0)
      setView('processing')
    } catch (err) {
      setError(err.message)
    }
  }

  function viewJob(job) {
    setJobResults(job)
    setPreview(job.originalUrl || null)
    setDetectedRoomType(job.autoDetected ? job.roomType : null)
    setView('results')
  }

  function viewProject(proj) {
    setCurrentProject(proj)
    setProjectView('project-gallery')
  }

  function startNew() {
    setFile(null); setPreview(null); setCurrentJob(null); setJobResults(null); setError(''); setImgDimensions(null); setDetectedRoomType(null)
    setProjectView(null)
    setView('upload')
  }

  function startNewProject() {
    setFile(null); setPreview(null); setError(''); setImgDimensions(null); setDetectedRoomType(null)
    setProjectName(''); setCurrentProject(null); setBatchFiles([]); setBatchPreviews([])
    setRoomType('auto'); setStyle('modern')
    setProjectView('create-hero')
    setView('project')
  }

  async function downloadImage(jobId) {
    try {
      const r = await fetch(`/api/staging/download/${jobId}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error('Download failed')
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const disposition = r.headers.get('Content-Disposition')
      const match = disposition?.match(/filename="(.+)"/)
      a.download = match ? match[1] : 'staged-room.jpg'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      if (jobResults?.results?.[0]?.url) {
        const a = document.createElement('a')
        a.href = jobResults.results[0].url
        a.download = 'staged-room.jpg'
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
      }
    }
  }

  function copyLink() {
    if (jobResults?.results?.[0]?.url) {
      navigator.clipboard.writeText(window.location.origin + jobResults.results[0].url)
        .then(() => alert('Link copied!'))
        .catch(() => {})
    }
  }

  function backToDashboard() {
    setProjectView(null)
    setView('dashboard')
  }

  const currentStep = PROCESSING_STEPS.findIndex((s, i) => {
    const next = PROCESSING_STEPS[i + 1]
    return !next || processingTime < next.time
  })

  // Render room type + style picker (shared between single and project flows)
  function renderConfigPanel({ onGenerate, generateLabel, showProjectName }) {
    return (
      <div className="config-panel">
        <h2 className="config-title">Configure Staging</h2>

        {showProjectName && (
          <>
            <label className="config-label">Project Name</label>
            <input
              type="text"
              className="config-name-input"
              placeholder="e.g. 123 Main St Living Room"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
            />
          </>
        )}

        <label className="config-label">Room Type</label>
        <div className="config-room-grid">
          {ROOM_TYPES.map(r => (
            <button
              key={r.id}
              className={`config-room-btn ${roomType === r.id ? 'config-room-btn--active' : ''}`}
              onClick={() => setRoomType(r.id)}
            >
              <span className="config-room-icon">{r.icon}</span>
              <span className="config-room-label">{r.label}</span>
            </button>
          ))}
        </div>

        <label className="config-label">Design Style</label>
        <div className="config-style-grid">
          {STYLES.map(s => (
            <button
              key={s.id}
              className={`config-style-btn ${style === s.id ? 'config-style-btn--active' : ''}`}
              onClick={() => setStyle(s.id)}
            >
              <div className="config-style-swatch" style={{ background: s.gradient }} />
              <div>
                <div className="config-style-name">{s.label}</div>
                <div className="config-style-desc">{s.desc}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="config-credit-notice">
          <span>⚡</span>
          <span>This will use <strong>1 credit</strong>. You have <strong>{credits ?? '...'}</strong> remaining.</span>
        </div>

        <button
          className="btn btn--primary btn--lg btn--full"
          style={{ marginTop: '1.5rem' }}
          disabled={uploading || (credits !== null && credits <= 0)}
          onClick={onGenerate}
        >
          {uploading ? 'Uploading...' : credits !== null && credits <= 0 ? 'No credits left' : generateLabel}
        </button>
      </div>
    )
  }

  return (
    <div className="dashboard-page">
      <nav className="nav">
        <div className="nav-inner">
          <a href="/" className="nav-logo" onClick={e => { e.preventDefault(); onLanding() }}>
            <Logo />
            <span>VirtueStage</span>
          </a>
          <div className="nav-links">
            <span className="nav-user">Hi, {user?.name || user?.email}</span>
            {credits !== null && (
              <span style={{ fontSize: '.85rem', color: '#f59e0b', fontWeight: 600 }}>
                {credits} credit{credits !== 1 ? 's' : ''}
              </span>
            )}
            <button className="btn btn--sm btn--ghost" onClick={backToDashboard}>My Stagings</button>
            <button className="btn btn--sm btn--primary" onClick={startNew}>+ New Staging</button>
            <button className="btn btn--sm btn--ghost" onClick={logout}>Sign Out</button>
          </div>
        </div>
      </nav>

      <div className="dashboard-content">
        {stagingMode === 'demo' && (
          <div className="demo-banner">
            <strong>Demo mode.</strong> No AI model is called: results are bundled sample images, not generated from your photo.
          </div>
        )}
        {error && (
          <div className="auth-error" style={{ maxWidth: 600, margin: '1rem auto' }}>
            {error}
            <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }}>✕</button>
          </div>
        )}

        {/* ═══ DASHBOARD ═══ */}
        {view === 'dashboard' && !projectView && (
          <div className="dash-section">
            <div className="credit-bar" style={{ marginTop: '1.5rem' }}>
              <div className="credit-bar-left">
                <div className="credit-count">{credits ?? '...'}</div>
                <div className="credit-label">
                  <strong>Staging Credits</strong>
                  {credits === 0 ? 'Paid plans are coming soon' : 'Available to use'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '.75rem' }}>
                <button className="btn btn--ghost btn--sm" onClick={startNewProject}>🏠 New Room Project</button>
                <button className="btn btn--primary btn--sm" onClick={startNew}>+ Stage a Room</button>
              </div>
            </div>

            {/* Projects section */}
            {projects.length > 0 && (
              <>
                <div className="dash-header">
                  <h2>Room Projects</h2>
                </div>
                <div className="dash-grid">
                  {projects.map(proj => {
                    const heroJob = proj.jobs?.[0]
                    const thumbUrl = heroJob?.thumbnailUrl || heroJob?.results?.[0]?.url || heroJob?.originalUrl
                    const angleCount = proj.jobs?.length || 0
                    const allComplete = proj.jobs?.every(j => j.status === 'complete')
                    const anyProcessing = proj.jobs?.some(j => j.status === 'processing' || j.status === 'queued')
                    return (
                      <div key={proj.id} className="dash-card" onClick={() => viewProject(proj)}>
                        <div className="dash-card-img">
                          {thumbUrl ? (
                            <img src={thumbUrl} alt="Project" loading="lazy" />
                          ) : (
                            <div className="dash-card-placeholder">🏠</div>
                          )}
                          {anyProcessing && <div className="dash-card-shimmer" />}
                          <div className="dash-card-angle-badge">{angleCount} angle{angleCount !== 1 ? 's' : ''}</div>
                        </div>
                        <div className="dash-card-info">
                          <span className="dash-card-style" style={{ color: '#f59e0b' }}>{proj.name || 'Untitled'}</span>
                          <span className={`dash-card-status dash-card-status--${allComplete ? 'complete' : anyProcessing ? 'processing' : 'queued'}`}>
                            {allComplete ? 'complete' : anyProcessing ? 'processing' : 'queued'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            <div className="dash-header">
              <h2>My Stagings</h2>
            </div>

            {jobs.length === 0 && projects.length === 0 ? (
              <div className="dash-empty">
                <div className="dash-empty-icon">🏠</div>
                <p style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '.5rem' }}>No staging jobs yet</p>
                <p style={{ marginBottom: '1.5rem' }}>Upload your first room photo and watch the magic happen!</p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn--primary" onClick={startNew}>Stage Your First Room →</button>
                  <button className="btn btn--ghost" onClick={startNewProject}>🏠 Start a Room Project</button>
                </div>
              </div>
            ) : jobs.length === 0 ? (
              <div className="dash-empty">
                <div className="dash-empty-icon">📷</div>
                <p style={{ marginBottom: '1rem' }}>No individual stagings yet</p>
                <button className="btn btn--primary btn--sm" onClick={startNew}>Stage a Room →</button>
              </div>
            ) : (
              <div className="dash-grid">
                {jobs.map(job => {
                  const thumbUrl = job.thumbnailUrl || job.results?.[0]?.url || job.originalUrl
                  return (
                    <div key={job.jobId} className="dash-card" onClick={() => job.status === 'complete' ? viewJob(job) : null}>
                      <div className="dash-card-img">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt="Room" loading="lazy" />
                        ) : (
                          <div className="dash-card-placeholder">🏠</div>
                        )}
                        {job.status === 'processing' && <div className="dash-card-shimmer" />}
                      </div>
                      <div className="dash-card-info">
                        <span className="dash-card-style" style={{ color: '#f59e0b' }}>{job.style}</span>
                        <span className={`dash-card-status dash-card-status--${job.status}`}>{job.status}</span>
                        <span className="dash-card-date">{new Date(job.created_at * 1000).toLocaleDateString()}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ UPLOAD (single image) ═══ */}
        {view === 'upload' && !projectView && (
          <div className="dash-section">
            <div className="upload-page">
              <h2 className="upload-title">Stage a Room</h2>
              <p className="upload-subtitle">Upload a photo of your empty room to get started</p>
              <PhotoTips />
              <div
                className={`upload-dropzone ${dragOver ? 'upload-dropzone--active' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById('file-input').click()}
              >
                <div className="upload-dropzone-inner">
                  <div className="upload-icon">📷</div>
                  <p className="upload-dropzone-text">Drag & drop your room photo here</p>
                  <p className="upload-dropzone-hint">or click to browse</p>
                  <p className="upload-dropzone-formats">JPG, PNG, WebP — up to 20MB</p>
                </div>
                <input id="file-input" type="file" accept="image/*" hidden onChange={e => handleFile(e.target.files[0])} />
              </div>
            </div>
          </div>
        )}

        {/* ═══ CONFIGURE (single image) ═══ */}
        {view === 'configure' && !projectView && (
          <div className="dash-section">
            <div className="config-layout">
              <div className="config-preview">
                <div className="config-preview-img">
                  {preview && <img src={preview} alt="Your room" />}
                </div>
                {imgDimensions && (
                  <div className="config-preview-dimensions">
                    {imgDimensions.w} × {imgDimensions.h}px
                  </div>
                )}
                <button className="btn btn--ghost btn--sm" onClick={startNew} style={{ marginTop: '.75rem', width: '100%' }}>
                  ↩ Choose different photo
                </button>
              </div>
              {renderConfigPanel({ onGenerate: handleGenerate, generateLabel: '✨ Generate Staging' })}
            </div>
          </div>
        )}

        {/* ═══ PROCESSING (single image) ═══ */}
        {view === 'processing' && !projectView && (
          <div className="dash-section">
            <div className="processing-page">
              <div className="processing-image-wrap">
                {preview && <img src={preview} alt="Processing" className="processing-image" />}
                <div className="processing-shimmer" />
              </div>
              <div className="processing-info">
                <div className="processing-spinner" />
                <h2>Staging your room...</h2>
                <p>Our AI is adding {STYLES.find(s => s.id === style)?.label || style} furniture & decor.</p>
                {roomType === 'auto' && <p style={{ color: '#f59e0b', fontSize: '.9rem' }}>🔮 Auto-detecting room type...</p>}
                <div className="processing-timer">{processingTime}s elapsed</div>
                <div className="processing-steps">
                  {PROCESSING_STEPS.map((step, i) => {
                    const done = i < currentStep
                    const active = i === currentStep
                    return (
                      <div key={i} className={`processing-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                        <span className="processing-step-icon">{done ? '✓' : active ? '◉' : '○'}</span>
                        <span>{step.label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ RESULTS (single image) ═══ */}
        {view === 'results' && !projectView && jobResults && (
          <div className="dash-section">
            <div className="results-page">
              <div className="results-header">
                <h2>Staging Complete! ✨</h2>
                <div className="results-meta">
                  <span className="results-badge">{jobResults.style}</span>
                  <span className="results-room">
                    {detectedRoomType || jobResults.autoDetected
                      ? `${roomTypeLabel(detectedRoomType || jobResults.roomType)} (auto-detected)`
                      : roomTypeLabel(jobResults.room_type)}
                  </span>
                </div>
              </div>

              {jobResults.results?.length > 0 ? (
                jobResults.results.map((r, i) => (
                  <div key={i} className="results-item">
                    {jobResults.originalUrl ? (
                      <CompareSlider before={jobResults.originalUrl} after={r.url} height={500} />
                    ) : (
                      <div className="results-single-img"><img src={r.url} alt="Staged room" /></div>
                    )}
                    <div className="results-item-info">
                      {r.metadata?.generation_time && <span>Generated in {Math.round(r.metadata.generation_time)}s</span>}
                      <button className="btn btn--sm btn--primary" onClick={() => downloadImage(jobResults.jobId)}>⬇ Download HD</button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="results-empty">
                  <p>No staged images were generated.</p>
                  {jobResults.error && <p className="auth-error">{jobResults.error}</p>}
                </div>
              )}

              <div className="results-actions">
                <button className="btn btn--primary" onClick={() => {
                  const otherStyles = STYLES.filter(s => s.id !== jobResults.style)
                  const newStyle = otherStyles[Math.floor(Math.random() * otherStyles.length)].id
                  handleRestage(jobResults.jobId, newStyle)
                }}>🎨 Try Another Style</button>
                <button className="btn btn--ghost" onClick={copyLink}>🔗 Copy Link</button>
                <button className="btn btn--ghost" onClick={startNew}>📷 Stage Another Room</button>
                <button className="btn btn--ghost" onClick={backToDashboard}>← Back to Dashboard</button>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════
            PROJECT FLOW
           ═══════════════════════════════════════ */}

        {/* Step 1: Upload hero image */}
        {projectView === 'create-hero' && (
          <div className="dash-section">
            <div className="upload-page">
              <h2 className="upload-title">New Room Project</h2>
              <p className="upload-subtitle">Upload your best angle (hero shot) to start the project</p>
              <PhotoTips />
              <div
                className={`upload-dropzone ${dragOver ? 'upload-dropzone--active' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById('project-file-input').click()}
              >
                <div className="upload-dropzone-inner">
                  <div className="upload-icon">🏠</div>
                  <p className="upload-dropzone-text">Drag & drop your hero photo here</p>
                  <p className="upload-dropzone-hint">Pick your best angle — this guides the style for all other angles</p>
                  <p className="upload-dropzone-formats">JPG, PNG, WebP — up to 20MB</p>
                </div>
                <input id="project-file-input" type="file" accept="image/*" hidden onChange={e => handleFile(e.target.files[0])} />
              </div>
              <button className="btn btn--ghost btn--sm" onClick={backToDashboard} style={{ marginTop: '1rem' }}>← Back</button>
            </div>
          </div>
        )}

        {/* Step 1b: Configure hero */}
        {projectView === 'configure-hero' && (
          <div className="dash-section">
            <div className="config-layout">
              <div className="config-preview">
                <div className="config-preview-img">
                  {preview && <img src={preview} alt="Hero shot" />}
                </div>
                {imgDimensions && (
                  <div className="config-preview-dimensions">{imgDimensions.w} × {imgDimensions.h}px</div>
                )}
                <button className="btn btn--ghost btn--sm" onClick={() => { setFile(null); setPreview(null); setProjectView('create-hero') }} style={{ marginTop: '.75rem', width: '100%' }}>
                  ↩ Choose different photo
                </button>
              </div>
              {renderConfigPanel({ onGenerate: handleCreateProject, generateLabel: '🏠 Create Project & Stage Hero', showProjectName: true })}
            </div>
          </div>
        )}

        {/* Step 2: Processing hero */}
        {projectView === 'processing-hero' && (
          <div className="dash-section">
            <div className="processing-page">
              <div className="processing-image-wrap">
                {preview && <img src={preview} alt="Processing hero" className="processing-image" />}
                <div className="processing-shimmer" />
              </div>
              <div className="processing-info">
                <div className="processing-spinner" />
                <h2>Staging hero shot...</h2>
                <p>Setting the style reference for your project.</p>
                <div className="processing-timer">{processingTime}s elapsed</div>
                <div className="processing-steps">
                  {PROCESSING_STEPS.map((step, i) => {
                    const done = i < currentStep
                    const active = i === currentStep
                    return (
                      <div key={i} className={`processing-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                        <span className="processing-step-icon">{done ? '✓' : active ? '◉' : '○'}</span>
                        <span>{step.label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Hero done — show result, add more angles */}
        {projectView === 'hero-done' && currentProject && (
          <div className="dash-section">
            <div className="results-page">
              <div className="results-header">
                <h2>Hero Shot Staged! ✨</h2>
                <p style={{ color: 'var(--text-secondary)', marginTop: '.5rem' }}>{currentProject.name || 'Untitled Project'}</p>
              </div>

              {(() => {
                const heroJob = currentProject.jobs?.[0]
                const heroResult = heroJob?.results?.[0]
                if (!heroResult) return <p style={{ color: 'var(--text-secondary)' }}>No result available.</p>
                return (
                  <div className="results-item">
                    {heroJob.originalUrl ? (
                      <CompareSlider before={heroJob.originalUrl} after={heroResult.url} height={500} />
                    ) : (
                      <div className="results-single-img"><img src={heroResult.url} alt="Staged hero" /></div>
                    )}
                  </div>
                )
              })()}

              <div className="results-actions">
                <button className="btn btn--primary btn--lg" onClick={() => { setBatchFiles([]); setBatchPreviews([]); setProjectView('batch-upload') }}>
                  📷 Add More Angles
                </button>
                <button className="btn btn--ghost" onClick={backToDashboard}>← Done for now</button>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Batch upload */}
        {projectView === 'batch-upload' && (
          <div className="dash-section">
            <div className="upload-page" style={{ maxWidth: 700 }}>
              <h2 className="upload-title">Add More Angles</h2>
              <p className="upload-subtitle">Upload up to 10 additional photos of the same room from different angles</p>
              <PhotoTips />
              <div
                className={`upload-dropzone ${batchDragOver ? 'upload-dropzone--active' : ''}`}
                onDragOver={e => { e.preventDefault(); setBatchDragOver(true) }}
                onDragLeave={() => setBatchDragOver(false)}
                onDrop={handleBatchDrop}
                onClick={() => document.getElementById('batch-file-input').click()}
              >
                <div className="upload-dropzone-inner">
                  <div className="upload-icon">📷</div>
                  <p className="upload-dropzone-text">Drag & drop multiple photos here</p>
                  <p className="upload-dropzone-hint">or click to browse — up to 10 images</p>
                  <p className="upload-dropzone-formats">JPG, PNG, WebP — up to 20MB each</p>
                </div>
                <input id="batch-file-input" type="file" accept="image/*" multiple hidden onChange={e => addBatchFiles(Array.from(e.target.files))} />
              </div>

              {batchPreviews.length > 0 && (
                <div className="batch-preview-grid">
                  {batchPreviews.map((url, i) => (
                    <div key={i} className="batch-preview-item">
                      <img src={url} alt={`Angle ${i + 1}`} />
                      <button className="batch-preview-remove" onClick={() => removeBatchFile(i)}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'center' }}>
                <button
                  className="btn btn--primary btn--lg"
                  disabled={batchFiles.length === 0 || uploading}
                  onClick={handleBatchUpload}
                >
                  {uploading ? 'Uploading...' : `✨ Stage ${batchFiles.length} Angle${batchFiles.length !== 1 ? 's' : ''}`}
                </button>
                <button className="btn btn--ghost" onClick={() => setProjectView('hero-done')}>← Back</button>
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Processing batch */}
        {projectView === 'processing-batch' && (
          <div className="dash-section">
            <div className="processing-page">
              <div className="processing-info">
                <div className="processing-spinner" />
                <h2>Staging all angles...</h2>
                <p>Processing {batchFiles.length} additional angle{batchFiles.length !== 1 ? 's' : ''} using the hero as reference.</p>
                <div className="processing-timer">{processingTime}s elapsed</div>
              </div>
            </div>
          </div>
        )}

        {/* Project Gallery */}
        {projectView === 'project-gallery' && currentProject && (
          <div className="dash-section">
            <div className="results-page" style={{ maxWidth: 1000 }}>
              <div className="results-header">
                <h2>{currentProject.name || 'Room Project'} 🏠</h2>
                <div className="results-meta">
                  <span className="results-badge">{currentProject.style || currentProject.jobs?.[0]?.style}</span>
                  <span className="results-room">{(currentProject.jobs?.length || 0)} angle{(currentProject.jobs?.length || 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>

              <div className="project-gallery-grid">
                {(currentProject.jobs || []).map((job, i) => {
                  const result = job.results?.[0]
                  if (!result) return (
                    <div key={i} className="project-gallery-card">
                      <div className="project-gallery-placeholder">
                        {job.status === 'processing' || job.status === 'queued' ? (
                          <><div className="processing-spinner" style={{ width: 24, height: 24 }} /><span>Processing...</span></>
                        ) : (
                          <span>Error</span>
                        )}
                      </div>
                      <div className="project-gallery-label">Angle {i + 1} {i === 0 ? '(Hero)' : ''}</div>
                    </div>
                  )
                  return (
                    <div key={i} className="project-gallery-card">
                      {job.originalUrl ? (
                        <CompareSlider before={job.originalUrl} after={result.url} />
                      ) : (
                        <img src={result.url} alt={`Angle ${i + 1}`} style={{ width: '100%', borderRadius: 'var(--radius)' }} />
                      )}
                      <div className="project-gallery-label">Angle {i + 1} {i === 0 ? '(Hero)' : ''}</div>
                    </div>
                  )
                })}
              </div>

              <div className="results-actions">
                <button className="btn btn--primary" onClick={() => { setBatchFiles([]); setBatchPreviews([]); setProjectView('batch-upload') }}>
                  📷 Add More Angles
                </button>
                <button className="btn btn--ghost" onClick={backToDashboard}>← Back to Dashboard</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
