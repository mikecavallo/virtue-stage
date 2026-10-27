export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect width="28" height="28" rx="6" fill="#f59e0b" />
      <path d="M7.5 8.5l6.5 11 6.5-11" stroke="#0f172a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Wordmark({ href = '#/', size = 26 }) {
  return (
    <a href={href} className="wordmark">
      <Logo size={size} />
      <span>VirtueStage</span>
    </a>
  )
}
