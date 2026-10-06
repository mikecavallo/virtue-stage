import React, { createContext, useContext, useState, useEffect } from 'react'

const API = '/api/auth'
const AuthContext = createContext(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setTokenState] = useState(() => localStorage.getItem('token'))
  // Only "loading" while validating a stored token on first load
  const [loading, setLoading] = useState(() => !!localStorage.getItem('token'))

  function setToken(t) {
    if (t) localStorage.setItem('token', t)
    else localStorage.removeItem('token')
    setTokenState(t)
  }

  useEffect(() => {
    if (!token) return
    fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setUser(d.user))
      .catch(() => { setToken(null); setUser(null) })
      .finally(() => setLoading(false))
  }, [token])

  async function login(email, password) {
    const r = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Login failed')
    setToken(d.token)
    setUser(d.user)
  }

  async function signup(email, password, name) {
    const r = await fetch(`${API}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Signup failed')
    setToken(d.token)
    setUser(d.user)
  }

  function logout() {
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
