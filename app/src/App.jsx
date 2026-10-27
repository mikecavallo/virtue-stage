import { useEffect, useState } from 'react'
import Landing from './pages/Landing.jsx'
import Studio from './pages/Studio.jsx'

// Hash routing so deep links work on GitHub Pages without server rewrites.
function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { page: parts[0] || 'home', arg: parts[1] || null }
}

export default function App() {
  const [route, setRoute] = useState(parseHash)

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    // Only reset scroll on page changes; in-page anchors (#how) are handled by the browser.
    if (route.page === 'studio') window.scrollTo(0, 0)
  }, [route.page])

  if (route.page === 'studio') return <Studio initialSample={route.arg} />
  return <Landing />
}
