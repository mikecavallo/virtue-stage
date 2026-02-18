import React, { useState, useRef, useEffect, useCallback } from 'react'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import DashboardPage from './pages/DashboardPage'

const rooms = [
  { id: 'living-room', label: 'Living Room', before: '/images/before/living-room.jpg', after: '/images/after/living-room.jpg' },
  { id: 'bedroom', label: 'Bedroom', before: '/images/before/bedroom.jpg', after: '/images/after/bedroom.jpg' },
  { id: 'kitchen', label: 'Kitchen', before: '/images/before/kitchen.jpg', after: '/images/after/kitchen.jpg' },
  { id: 'dining-room', label: 'Dining Room', before: '/images/before/dining-room.jpg', after: '/images/after/dining-room.jpg' },
  { id: 'bathroom', label: 'Bathroom', before: '/images/before/bathroom.jpg', after: '/images/after/bathroom.jpg' },
]

/* ─── Logo SVG ─── */
function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="6" fill="#f59e0b"/>
      <path d="M8 20V8l6 12 6-12v12" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

/* ─── Before / After Slider ─── */
function CompareSlider({ before, after, label }) {
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
    <div className="compare-slider-wrap">
      {label && <h3 className="compare-label">{label}</h3>}
      <div ref={containerRef} className="compare-slider" onMouseDown={startDrag} onTouchStart={startDrag}>
        <img src={after} alt="After staging" className="compare-img" draggable={false} />
        <div className="compare-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <img src={before} alt="Before staging" className="compare-img" draggable={false} />
        </div>
        <span className="compare-tag compare-tag--before">Before</span>
        <span className="compare-tag compare-tag--after">After</span>
        <div className="compare-handle" style={{ left: `${pos}%` }}>
          <div className="compare-handle-line" />
          <div className="compare-handle-knob">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l-5 6 5 6M13 4l5 6-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── FAQ Item ─── */
function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`faq-item ${open ? 'open' : ''}`}>
      <div className="faq-q" onClick={() => setOpen(!open)}>{q}</div>
      <div className="faq-a">{a}</div>
    </div>
  )
}

/* ─── Landing Page ─── */
function LandingPage({ onLogin, onSignup }) {
  return (
    <div className="page">
      <nav className="nav">
        <div className="nav-inner">
          <a href="#" className="nav-logo">
            <Logo />
            <span>VirtueStage</span>
          </a>
          <div className="nav-links">
            <a href="#gallery">Gallery</a>
            <a href="#how">How It Works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href="#" className="btn btn--sm btn--ghost" onClick={e => { e.preventDefault(); onLogin() }}>Sign In</a>
            <a href="#" className="btn btn--sm btn--primary" onClick={e => { e.preventDefault(); onSignup() }}>Get Started Free</a>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="hero">
        <div className="hero-bg" />
        <div className="hero-bg-2" />
        <div className="hero-content">
          <span className="badge">AI-Powered Virtual Staging</span>
          <h1 className="hero-title">
            Empty rooms don't sell.<br/>
            <span className="text-accent">Staged rooms do.</span>
          </h1>
          <p className="hero-sub">
            Transform vacant listings into move-in-ready dream homes in under 60 seconds.
            Photorealistic AI staging that helps properties sell 73% faster.
          </p>
          <div className="hero-ctas">
            <a href="#" className="btn btn--primary btn--lg" onClick={e => { e.preventDefault(); onSignup() }}>Stage Your First Room Free →</a>
            <a href="#gallery" className="btn btn--ghost btn--lg">See Examples ↓</a>
          </div>
        </div>
        <div className="hero-slider">
          <CompareSlider before={rooms[0].before} after={rooms[0].after} />
        </div>
      </section>

      {/* STATS */}
      <section className="stats">
        <div className="stats-grid">
          <div className="stat"><span className="stat-num">73%</span><span className="stat-label">Faster Sales</span></div>
          <div className="stat"><span className="stat-num">$11K</span><span className="stat-label">Avg. Price Increase</span></div>
          <div className="stat"><span className="stat-num">60s</span><span className="stat-label">Average Turnaround</span></div>
          <div className="stat"><span className="stat-num">12K+</span><span className="stat-label">Rooms Staged</span></div>
        </div>
      </section>

      {/* GALLERY */}
      <section id="gallery" className="gallery">
        <div className="section-header">
          <span className="badge">Real Results</span>
          <h2 className="section-title">See the transformation</h2>
          <p className="section-sub">Every image was generated by our AI in under 60 seconds. Drag the slider to compare.</p>
        </div>
        <div className="gallery-grid">
          {rooms.map((room) => (
            <CompareSlider key={room.id} before={room.before} after={room.after} label={room.label} />
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="how">
        <div className="section-header">
          <span className="badge badge--dark">Simple Process</span>
          <h2 className="section-title light">Three steps. That's it.</h2>
        </div>
        <div className="steps-grid">
          <div className="step">
            <div className="step-num">1</div>
            <h3>Upload</h3>
            <p>Drop in a photo of your empty room. Any angle, any size.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <div className="step-num">2</div>
            <h3>Choose Style</h3>
            <p>Pick from Modern, Scandinavian, Luxury, Bohemian, and more.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <div className="step-num">3</div>
            <h3>Download</h3>
            <p>Get your photorealistic staged image in under 60 seconds.</p>
          </div>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="proof">
        <div className="section-header">
          <span className="badge">Social Proof</span>
          <h2 className="section-title">Trusted by top agents</h2>
          <p className="section-sub">Thousands of realtors use VirtueStage to close deals faster.</p>
        </div>
        <div className="testimonials">
          <div className="testimonial">
            <div className="testimonial-stars">★★★★★</div>
            <p>"VirtueStage saved me $4,000 on physical staging and my listing sold in 5 days. The quality is indistinguishable from real photos."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">SC</div>
              <div><strong>Sarah Chen</strong><span>Coldwell Banker, San Francisco</span></div>
            </div>
          </div>
          <div className="testimonial">
            <div className="testimonial-stars">★★★★★</div>
            <p>"I use it for every vacant listing now. My clients are amazed at how quickly I can show them what a space could look like."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">MW</div>
              <div><strong>Marcus Williams</strong><span>RE/MAX, Austin TX</span></div>
            </div>
          </div>
          <div className="testimonial">
            <div className="testimonial-stars">★★★★★</div>
            <p>"The ROI is insane. I spent $29 on staging and got $11K more on the sale price. Every agent needs this tool."</p>
            <div className="testimonial-author">
              <div className="testimonial-avatar">JP</div>
              <div><strong>Jessica Park</strong><span>Keller Williams, Chicago</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="pricing">
        <div className="section-header">
          <span className="badge">Pricing</span>
          <h2 className="section-title">Simple, transparent pricing</h2>
          <p className="section-sub">Start free. Upgrade when you're ready.</p>
        </div>
        <div className="pricing-grid">
          <div className="price-card">
            <h3>Free</h3>
            <p className="price-desc">Try it out</p>
            <div className="price"><span className="price-amount">$0</span></div>
            <ul className="price-features">
              <li>✓ 3 staged images</li>
              <li>✓ All 6 design styles</li>
              <li>✓ Standard quality</li>
              <li>✓ Watermarked output</li>
            </ul>
            <a href="#" className="btn btn--outline btn--full" onClick={e => { e.preventDefault(); onSignup() }}>Get Started Free</a>
          </div>
          <div className="price-card price-card--featured">
            <div className="price-badge">Most Popular</div>
            <h3>Pro</h3>
            <p className="price-desc">For active agents</p>
            <div className="price"><span className="price-amount">$29</span><span className="price-unit">/month</span></div>
            <ul className="price-features">
              <li>✓ Unlimited stagings</li>
              <li>✓ No watermark</li>
              <li>✓ Priority processing</li>
              <li>✓ High resolution output</li>
              <li>✓ Priority support</li>
            </ul>
            <a href="#" className="btn btn--primary btn--full" onClick={e => { e.preventDefault(); onSignup() }}>Start Pro Trial</a>
          </div>
          <div className="price-card">
            <h3>Enterprise</h3>
            <p className="price-desc">Brokerages & teams</p>
            <div className="price"><span className="price-amount">Custom</span></div>
            <ul className="price-features">
              <li>✓ Unlimited stagings</li>
              <li>✓ API access</li>
              <li>✓ Bulk processing</li>
              <li>✓ White-label option</li>
              <li>✓ Dedicated account manager</li>
            </ul>
            <a href="#" className="btn btn--outline btn--full">Contact Sales</a>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="faq">
        <div className="section-header">
          <span className="badge">FAQ</span>
          <h2 className="section-title">Frequently asked questions</h2>
        </div>
        <FAQItem q="How realistic are the staged images?" a="Our AI produces photorealistic results that are virtually indistinguishable from professional photography. We use advanced image generation technology trained specifically for interior design and real estate." />
        <FAQItem q="How long does it take to stage a room?" a="Most rooms are staged in 30-60 seconds. Complex rooms or high-resolution images may take slightly longer." />
        <FAQItem q="Can I use the images in MLS listings?" a="Absolutely! Our images are designed for MLS listings, Zillow, Realtor.com, and all major real estate platforms. We recommend disclosing that images are virtually staged, as required by most MLS boards." />
        <FAQItem q="What if I don't like the result?" a="You can try different styles on the same photo at no extra cost (one credit per generation). Most agents find the perfect look within 1-2 tries." />
        <FAQItem q="Do you offer refunds?" a="Yes, we offer a full refund within 7 days if you're not satisfied with the Pro plan. Free tier credits are non-refundable." />
        <FAQItem q="Can I stage furnished rooms?" a="VirtueStage works best with empty or mostly empty rooms. For furnished rooms, results may vary as the AI may blend new furniture with existing items." />
      </section>

      {/* CTA */}
      <section className="cta">
        <div className="cta-inner">
          <h2>Ready to sell faster?</h2>
          <p>Stage your first room free. No credit card required.</p>
          <button className="btn btn--primary btn--lg" onClick={onSignup}>Get Started Free →</button>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="nav-logo" style={{ fontSize: '1.1rem' }}>
              <Logo size={24} />
              VirtueStage
            </span>
            <p>AI-powered virtual staging for real estate professionals. Transform empty spaces into dream homes.</p>
          </div>
          <div className="footer-links">
            <div><h4>Product</h4><a href="#">Virtual Staging</a><a href="#pricing">Pricing</a><a href="#">API</a></div>
            <div><h4>Company</h4><a href="#">About</a><a href="#">Blog</a><a href="#">Careers</a></div>
            <div><h4>Support</h4><a href="#">Help Center</a><a href="#">Contact</a><a href="#">Status</a></div>
          </div>
        </div>
        <div className="footer-bottom"><p>&copy; 2026 VirtueStage. All rights reserved.</p></div>
      </footer>
    </div>
  )
}

/* ─── App Router ─── */
function AppRouter() {
  const { user, loading } = useAuth()
  const [page, setPage] = useState('landing')

  useEffect(() => {
    if (user && (page === 'login' || page === 'signup')) setPage('dashboard')
  }, [user])

  if (loading) return <div className="auth-page"><div className="spinner" /></div>

  if (user && (page === 'dashboard' || page === 'login' || page === 'signup')) {
    return <DashboardPage onLanding={() => setPage('landing')} />
  }

  if (page === 'login') return <LoginPage onSwitch={() => setPage('signup')} />
  if (page === 'signup') return <SignupPage onSwitch={() => setPage('login')} />

  return <LandingPage onLogin={() => setPage('login')} onSignup={() => setPage('signup')} />
}

function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  )
}

export default App
