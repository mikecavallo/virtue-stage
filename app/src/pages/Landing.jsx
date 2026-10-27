import { useEffect, useState } from 'react'
import { ArrowRight, Eraser, Github, Layers, MousePointerClick, Palette, ScanSearch, ShieldCheck, Sparkles, Stamp } from 'lucide-react'
import { Wordmark } from '../components/Logo.jsx'
import CompareSlider from '../components/CompareSlider.jsx'
import { loadInventory, sampleBase, sampleImage } from '../lib/samples.js'

const REPO = 'https://github.com/mikecavallo/virtue-stage'

// Hero: the real living-room sample with its real (precomputed) object outlines.
function HeroPreview() {
  const [inv, setInv] = useState(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    let alive = true
    loadInventory('living-room').then((v) => alive && setInv(v))
    return () => {
      alive = false
    }
  }, [])

  const objects = inv?.objects || []
  useEffect(() => {
    if (!objects.length) return
    const t = setInterval(() => setActive((a) => (a + 1) % objects.length), 1600)
    return () => clearInterval(t)
  }, [objects.length])

  const current = objects[active]
  return (
    <a className="hero-preview" href="#/studio/living-room" aria-label="Open the living room in the studio">
      <img src={sampleImage('living-room')} alt="Furnished living room with armchairs and a dining area" />
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        {objects.map((o, i) => (
          <polygon key={o.id} points={o.mask.map(([x, y]) => `${x},${y}`).join(' ')} className={`obj ${i === active ? 'obj--selected' : 'obj--idle'}`} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {current && (
        <span className="editor-chip" style={{ left: `${current.box_2d[1] / 10}%`, top: `${current.box_2d[0] / 10}%` }}>
          {current.label}
        </span>
      )}
      <span className="hero-preview-cta">
        <MousePointerClick size={16} /> Tap to edit
      </span>
    </a>
  )
}

const DECLUTTER_SAMPLE = 'bathroom'

function DeclutterShowcase() {
  const [inv, setInv] = useState(null)
  useEffect(() => {
    let alive = true
    loadInventory(DECLUTTER_SAMPLE).then((v) => alive && setInv(v))
    return () => {
      alive = false
    }
  }, [])
  if (!inv?.declutter) return null
  return (
    <section className="section">
      <div className="section-head">
        <span className="badge">Occupied homes</span>
        <h2>Clear the clutter, keep the house</h2>
        <p>Every movable item removed in one pass: plants, stool, bin, mirror. Tile, cabinets, and fixtures are the original pixels. Drag to compare.</p>
      </div>
      <div className="declutter">
        <CompareSlider
          before={sampleImage(DECLUTTER_SAMPLE)}
          after={`${sampleBase(DECLUTTER_SAMPLE)}${inv.declutter}`}
          beforeLabel="As photographed"
          afterLabel="Decluttered"
          aspect={`${inv.width} / ${inv.height}`}
          className="compare--wide"
        />
      </div>
    </section>
  )
}

const STEPS = [
  {
    icon: ScanSearch,
    title: 'Segment',
    text: 'Gemini 3.8 Flash returns a labeled outline for every movable object: sofa, rug, pillow, lamp. Items resting on furniture are linked to it.',
  },
  {
    icon: MousePointerClick,
    title: 'Tap',
    text: 'Hit-testing runs in the browser against the polygons. The smallest object under your finger wins, so you get the pillow, not the sofa.',
  },
  {
    icon: Sparkles,
    title: 'Edit',
    text: 'Nano Banana 2.1 gets the photo plus a copy with the object highlighted in magenta, and a prompt to remove, restyle, or replace it.',
  },
  {
    icon: Layers,
    title: 'Paste back',
    text: 'Only pixels inside the feathered outline are taken from the model. If the model shifted the photo, a drift check catches it and retries.',
  },
]

export default function Landing() {
  return (
    <div className="landing">
      <nav className="nav">
        <div className="nav-inner">
          <Wordmark />
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#lock">Architecture lock</a>
            <a href="#disclosure">Disclosure</a>
            <a href={REPO} target="_blank" rel="noreferrer" aria-label="Source on GitHub">
              <Github size={18} />
            </a>
            <a href="#/studio/living-room" className="btn btn--primary btn--sm">
              Open studio
            </a>
          </div>
        </div>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <span className="badge">Portfolio project · AI photo editing</span>
          <h1>
            Tap the furniture.
            <br />
            <span className="accent">Change the room.</span>
          </h1>
          <p className="lead">
            VirtueStage finds every piece of furniture in a listing photo. Tap one to remove it, recolor it, restyle it, or replace it. The AI only touches the pixels you tapped, so walls,
            windows, and floors stay exactly as photographed.
          </p>
          <div className="hero-ctas">
            <a href="#/studio/living-room" className="btn btn--primary btn--lg">
              Try the demo <ArrowRight size={18} />
            </a>
            <a href={REPO} className="btn btn--ghost btn--lg" target="_blank" rel="noreferrer">
              <Github size={18} /> Source
            </a>
          </div>
          <p className="muted small">No sign-up. Runs in your browser. Bring your own Gemini key for live AI.</p>
        </div>
        <HeroPreview />
      </header>

      <section className="features">
        {[
          [Eraser, 'Remove', 'Furniture, clutter, and what rests on it, with shadows.'],
          [Palette, 'Recolor', 'Instant, in-browser. Keeps the fabric texture.'],
          [Sparkles, 'Restyle and replace', '"Black leather", "a mid-century sofa".'],
          [Stamp, 'Disclose', 'Exports carry an AB 723 label and a change log.'],
        ].map(([Icon, title, text]) => (
          <div key={title} className="feature">
            <Icon size={20} />
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </div>
        ))}
      </section>

      <section id="how" className="section">
        <div className="section-head">
          <span className="badge">How it works</span>
          <h2>Segment, tap, edit, paste back</h2>
          <p>No backend. The browser talks to Gemini directly with the visitor's own key, and does all masking and compositing on a canvas.</p>
        </div>
        <ol className="steps">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="step">
              <span className="step-num">{i + 1}</span>
              <Icon size={22} />
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <DeclutterShowcase />

      <section id="lock" className="section">
        <div className="section-head">
          <span className="badge">Architecture lock</span>
          <h2>Why the model never gets the whole photo</h2>
          <p>
            The first version of this project asked an image model to stage the entire photo. It returned a nice room, just not this one: different windows, different walls, a different
            view. In a listing, that's misrepresentation.
          </p>
        </div>
        <div className="lock-grid">
          <figure>
            <img src={sampleImage('living-room')} alt="Original living room photo" loading="lazy" />
            <figcaption>The photo that was uploaded</figcaption>
          </figure>
          <figure className="bad">
            <img src={`${sampleBase('living-room')}legacy-prototype.jpg`} alt="Prototype output that changed the room's architecture" loading="lazy" />
            <figcaption>v1 output (2025): a different room entirely</figcaption>
          </figure>
        </div>
        <div className="lock-points">
          <div>
            <ShieldCheck size={18} />
            <p>
              <strong>Object edits are masked.</strong> The model's output is used only inside the tapped object's outline. Everything else is the original photo.
            </p>
          </div>
          <div>
            <ScanSearch size={18} />
            <p>
              <strong>Staging is checked.</strong> Whole-room staging can't be masked, so a vision model compares before and after for changed walls, windows, or floors and regenerates
              once with the problems listed.
            </p>
          </div>
        </div>
      </section>

      <section id="disclosure" className="section">
        <div className="section-head">
          <span className="badge">Disclosure</span>
          <h2>Built for the rules agents now work under</h2>
          <p>
            California's AB 723 took effect on January 1, 2026. Digitally altered listing photos need a visible disclosure and a link to the original. Export stamps the label, offers the
            original as a separate download, and produces a plain-English change log.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="badge">Under the hood</span>
          <h2>Stack</h2>
        </div>
        <ul className="stack">
          <li>
            <strong>React 19 + Vite</strong>, static build on GitHub Pages
          </li>
          <li>
            <strong>Gemini 3.8 Flash</strong> for room detection, segmentation polygons, and the architecture check
          </li>
          <li>
            <strong>Nano Banana 2.1</strong> (gemini-nano-banana-2.1) for staging and object edits
          </li>
          <li>
            <strong>Canvas 2D</strong> for masks, feathering, compositing, LAB recoloring, and drift checks
          </li>
          <li>
            <strong>Grounding DINO + SAM + LaMa</strong>, run offline, for the keyless demo data
          </li>
          <li>
            <strong>Vitest</strong> for geometry, color math, prompts, and the API client
          </li>
        </ul>
      </section>

      <section className="cta">
        <h2>See it on a real photo</h2>
        <a href="#/studio/living-room" className="btn btn--primary btn--lg">
          Open the studio <ArrowRight size={18} />
        </a>
      </section>

      <footer className="footer">
        <Wordmark />
        <p className="muted small">
          A portfolio project by{' '}
          <a href="https://github.com/mikecavallo" target="_blank" rel="noreferrer">
            mikecavallo
          </a>
          . Not affiliated with Google. AI edits can be wrong; always disclose altered listing photos.
        </p>
      </footer>
    </div>
  )
}
