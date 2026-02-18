import React, { useState } from 'react'
import { useAuth } from '../auth'

export default function SignupPage({ onSwitch }) {
  const { signup } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 6) { setError('Password must be at least 6 characters'); return }
    setLoading(true)
    try { await signup(email, password, name) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="6" fill="#f59e0b"/><path d="M8 20V8l6 12 6-12v12" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>VirtueStage</span>
        </div>
        <h2>Create your account</h2>
        <p className="auth-sub">Start staging rooms in seconds — 3 free credits included</p>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="Jane Smith" />
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••" />
          <button type="submit" className="btn btn--primary btn--full" disabled={loading}>
            {loading ? 'Creating account...' : 'Create Account — It\'s Free'}
          </button>
        </form>
        <p className="auth-switch">Already have an account? <a href="#" onClick={e => { e.preventDefault(); onSwitch() }}>Sign in</a></p>
      </div>
    </div>
  )
}
