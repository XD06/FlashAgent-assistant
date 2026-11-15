import React, { useId } from 'react'

type IconProps = {
  size?: number
  strokeWidth?: number
  filled?: boolean
}

function baseProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
}

/** FlClash-inspired filled glyph helper: paints solid `body` shapes clipped by a negative-space `details` mask. */
function FilledCutoutSvg({
  size,
  strokeWidth,
  body,
  details
}: {
  size: number
  strokeWidth: number
  body: React.ReactNode
  details: React.ReactNode
}) {
  const maskId = useId()
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" />
          <g stroke="black" fill="none" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
            {details}
          </g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`} fill="currentColor" stroke="currentColor" strokeWidth={0.9}>
        {body}
      </g>
    </svg>
  )
}

function CircleHelp({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  const body = <circle cx="12" cy="12" r="8.8" />
  const details = (
    <>
      <path d="M9.6 9.3a2.6 2.6 0 0 1 4.9 1.2c0 1.6-1.8 2.2-2.5 3.1" />
      <circle cx="12" cy="16.6" r="1.05" fill={filled ? 'black' : 'currentColor'} stroke="none" />
    </>
  )
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Terminal({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function LinkIcon({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function FileText({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  const body = <path d="M14.2 3H6.8A2.3 2.3 0 0 0 4.5 5.3v13.4A2.3 2.3 0 0 0 6.8 21h10.4a2.3 2.3 0 0 0 2.3-2.3V8.3Z" />
  const details = (
    <>
      <path d="M14 3.2v4.3a1 1 0 0 0 1 1h4.3" />
      <path d="M8.5 13h7" />
      <path d="M8.5 16.5h4.5" />
    </>
  )
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Summarize({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  // FlClash AppGlyphs.rules-inspired bullet summary card: rounded superellipse
  // frame containing 3 concise takeaway bullets.
  const body = <rect x="3.5" y="4" width="17" height="16" rx="3.2" />
  const dotFill = filled ? 'black' : 'currentColor'
  const details = (
    <>
      <circle cx="7.6" cy="8.4" r="1.05" fill={dotFill} stroke="none" />
      <path d="M10.7 8.4h5.8" />
      <circle cx="7.6" cy="12" r="1.05" fill={dotFill} stroke="none" />
      <path d="M10.7 12h5.8" />
      <circle cx="7.6" cy="15.6" r="1.05" fill={dotFill} stroke="none" />
      <path d="M10.7 15.6h3.8" />
    </>
  )
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Blocks({ size = 16, strokeWidth = 2 }: IconProps) {
  // Extensions: 2x2 grid of rounded tiles — cleaner at small sizes than the
  // old interlocking-blocks outline.
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect width="7" height="7" x="3.5" y="3.5" rx="1.5" />
      <rect width="7" height="7" x="13.5" y="3.5" rx="1.5" />
      <rect width="7" height="7" x="3.5" y="13.5" rx="1.5" />
      <rect width="7" height="7" x="13.5" y="13.5" rx="1.5" />
    </svg>
  )
}

function RefreshCw({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function ChevronRight({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function CopyIcon({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect x="8.5" y="8" width="11.5" height="12.5" rx="2.6" fill={filled ? 'currentColor' : 'none'} />
      <path d="M6.5 16H6a2.2 2.2 0 0 1-2.2-2.2V6A2.2 2.2 0 0 1 6 3.8h7.8A2.2 2.2 0 0 1 16 6v.4" />
    </svg>
  )
}

function FlaskConical({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M10 3h4" />
      <path d="M10 3v4.5l-5.8 9.5A2 2 0 0 0 5.9 20h12.2a2 2 0 0 0 1.7-3l-5.8-9.5V3" />
      <path d="M8 13h8" />
    </svg>
  )
}

function Languages({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={filled ? 2.15 : strokeWidth}>
      <path d="M7.2 3.5v2.1" />
      <path d="M3.2 5.6h8" />
      <path d="M9.6 5.6c-.4 2.9-2.2 5.3-5.2 6.8" />
      <path d="M5.1 7.8c1 1.6 2.6 3.1 4.8 4.2" />
      <path d="M12.8 20.4l3.5-8.6a.65.65 0 0 1 1.2 0l3.5 8.6" />
      <path d="M14.1 17.4h5.6" />
    </svg>
  )
}

function Laptop({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect x="5" y="6" width="14" height="10" rx="2" />
      <path d="M3 18h18" />
    </svg>
  )
}

function Moon({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M20 14.5A7.5 7.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z" />
    </svg>
  )
}

function Eye({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}

function EyeOff({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M9.9 4.4A10.9 10.9 0 0 1 12 4.2c6 0 9.5 5.8 9.5 5.8a17.2 17.2 0 0 1-3.1 3.7" />
      <path d="M6.4 6.3A17.1 17.1 0 0 0 2.5 12S6 17.8 12 17.8c1.3 0 2.5-.3 3.5-.7" />
      <path d="m3 3 18 18" />
      <path d="M9.8 9.8a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}

function Pin({ size = 16, strokeWidth = 2 }: IconProps) {
  // Upright pushpin (lucide v2) — the old angled pin read as a paper plane.
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  )
}

function PinOff({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 17v5" />
      <path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89" />
      <path d="m2 2 20 20" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </svg>
  )
}

function ScanText({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M7 4H5.3A2.3 2.3 0 0 0 3 6.3V8" />
      <path d="M17 4h1.7A2.3 2.3 0 0 1 21 6.3V8" />
      <path d="M7 20H5.3A2.3 2.3 0 0 1 3 17.7V16" />
      <path d="M17 20h1.7A2.3 2.3 0 0 0 21 17.7V16" />
      <path d="M8 8.5h8" />
      <path d="M8 12h8" />
      <path d="M8 15.5h5" />
    </svg>
  )
}

function SearchIcon({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={filled ? 2.1 : strokeWidth}>
      <circle cx="10.5" cy="10.5" r="6.7" />
      <path d="m15.3 15.3 4.8 4.8" />
    </svg>
  )
}

function Sparkles({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  // FlClash AppGlyphs.sparkle: balanced large + small curved 4-point stars.
  const fill = filled ? 'currentColor' : 'none'
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M10 6.4 Q11.3 12.5 17.4 13.8 Q11.3 15.1 10 21.2 Q8.7 15.1 2.6 13.8 Q8.7 12.5 10 6.4 Z" fill={fill} />
      <path d="M17.8 2.9 Q18.5 5.5 21.1 6.2 Q18.5 6.9 17.8 9.5 Q17.1 6.9 14.5 6.2 Q17.1 5.5 17.8 2.9 Z" fill={fill} />
    </svg>
  )
}

function Bolt({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  // FlClash AppGlyphs.bolt: clean quick-action lightning silhouette.
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M14.2 3L5.2 13.5h6l-1.5 7.5 9-10.5h-6Z" fill={filled ? 'currentColor' : 'none'} />
    </svg>
  )
}

function Keyboard({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  // FlClash AppGlyphs.keyboard: rounded superellipse housing with 8 keys + spacebar.
  const body = <rect x="3" y="4.8" width="18" height="14.4" rx="3" />
  const dotFill = filled ? 'black' : 'currentColor'
  const details = (
    <>
      <circle cx="7" cy="8.6" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="10.3" cy="8.6" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="13.7" cy="8.6" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="17" cy="8.6" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="7" cy="12" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="10.3" cy="12" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="13.7" cy="12" r="0.95" fill={dotFill} stroke="none" />
      <circle cx="17" cy="12" r="0.95" fill={dotFill} stroke="none" />
      <path d="M8.5 15.5h7" />
    </>
  )
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Palette({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  // FlClash AppGlyphs.palette: painter's palette with 4 color dots.
  const body = (
    <path d="M20.59 13.9A8.8 8.8 0 1 0 13.9 20.59A1.2 1.2 0 0 0 14.83 19.28A4 4 0 0 1 19.28 14.83A1.2 1.2 0 0 0 20.59 13.9Z" />
  )
  const dotFill = filled ? 'black' : 'currentColor'
  const details = (
    <>
      <circle cx="7.54" cy="13.89" r="1.25" fill={dotFill} stroke="none" />
      <circle cx="7.96" cy="9.32" r="1.25" fill={dotFill} stroke="none" />
      <circle cx="12" cy="7.15" r="1.25" fill={dotFill} stroke="none" />
      <circle cx="16.04" cy="9.32" r="1.25" fill={dotFill} stroke="none" />
    </>
  )
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Square({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

function Sun({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2" />
      <path d="M12 19.3v2.2" />
      <path d="m4.8 4.8 1.6 1.6" />
      <path d="m17.6 17.6 1.6 1.6" />
      <path d="M2.5 12h2.2" />
      <path d="M19.3 12h2.2" />
      <path d="m4.8 19.2 1.6-1.6" />
      <path d="m17.6 6.4 1.6-1.6" />
    </svg>
  )
}

function Trash2({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M4 7h16" />
      <path d="M10 3h4" />
      <path d="M6.5 7 7.3 19a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  )
}

function XIcon({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

function Download({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 19h14" />
    </svg>
  )
}

function ArrowUp({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 5v14" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  )
}

function ArrowDown({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  )
}

function Pencil({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  )
}

function ArrowUpRight({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}

function Undo2({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  )
}

function MousePointer({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path
        d="M5.2 4.3a.8.8 0 0 1 1-.9l13.2 5.4a.8.8 0 0 1 0 1.5l-5.6 2.1-2.1 5.6a.8.8 0 0 1-1.5 0Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

function Power({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 3v9" />
      <path d="M6.4 7.4a8 8 0 1 0 11.2 0" />
    </svg>
  )
}

function BookOpen({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  const body = (
    <path d="M12 6.4C10.4 4.9 7.8 4.4 4.2 4.4A1.2 1.2 0 0 0 3 5.6v11.6a1.2 1.2 0 0 0 1.2 1.2c3.6 0 6.2.5 7.8 2 1.6-1.5 4.2-2 7.8-2a1.2 1.2 0 0 0 1.2-1.2V5.6a1.2 1.2 0 0 0-1.2-1.2c-3.6 0-6.2.5-7.8 2Z" />
  )
  const details = <path d="M12 6.4v13.8" />
  if (filled) return <FilledCutoutSvg size={size} strokeWidth={strokeWidth} body={body} details={details} />
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      {body}
      {details}
    </svg>
  )
}

function Volume2({ size = 16, strokeWidth = 1.8, filled = false }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path
        d="M11 5.5a1 1 0 0 0-1.7-.7L6 8.2H3.8A1.3 1.3 0 0 0 2.5 9.5v5a1.3 1.3 0 0 0 1.3 1.3H6l3.3 3.4a1 1 0 0 0 1.7-.7Z"
        fill={filled ? 'currentColor' : 'none'}
      />
      <path d="M15.5 8.8a4.8 4.8 0 0 1 0 6.4" />
      <path d="M18.6 6a8.6 8.6 0 0 1 0 12" />
    </svg>
  )
}

function Globe({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  )
}

function Plus({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function History({ size = 16, strokeWidth = 2 }: IconProps) {
  // Left side panel — matches the slide-in history drawer; the old
  // arrow-around-clock was illegible at 15px.
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  )
}

function CornerDownRight({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M15 10l5 5-5 5" />
      <path d="M4 4v7a4 4 0 0 0 4 4h12" />
    </svg>
  )
}

function Clock({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

function Minus({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M5 12h14" />
    </svg>
  )
}

function ArrowRightLeft({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H4" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  )
}

function ChevronDown({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function Check({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function Folder({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function PanelLeftClose({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect width="18" height="18" x="3" y="3" rx="2.5" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  )
}

function PanelLeftOpen({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect width="18" height="18" x="3" y="3" rx="2.5" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </svg>
  )
}

function Github({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.01c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

const icons: Record<string, (props: IconProps) => React.JSX.Element> = {
  github: Github,
  'circle-help': CircleHelp,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-up-right': ArrowUpRight,
  'arrow-right-left': ArrowRightLeft,
  'book-open': BookOpen,
  bolt: Bolt,
  power: Power,
  copy: CopyIcon,
  download: Download,
  'flask-conical': FlaskConical,
  eye: Eye,
  'eye-off': EyeOff,
  keyboard: Keyboard,
  languages: Languages,
  laptop: Laptop,
  moon: Moon,
  'mouse-pointer': MousePointer,
  palette: Palette,
  pencil: Pencil,
  pin: Pin,
  'pin-off': PinOff,
  'scan-text': ScanText,
  search: SearchIcon,
  sparkles: Sparkles,
  summarize: Summarize,
  square: Square,
  sun: Sun,
  'trash-2': Trash2,
  'undo-2': Undo2,
  'volume-2': Volume2,
  x: XIcon,
  globe: Globe,
  plus: Plus,
  history: History,
  terminal: Terminal,
  blocks: Blocks,
  link: LinkIcon,
  'file-text': FileText,
  'refresh-cw': RefreshCw,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  check: Check,
  'corner-down-right': CornerDownRight,
  clock: Clock,
  minus: Minus,
  incognito: Incognito,
  'new-topic': NewTopic,
  brain: Brain,
  folder: Folder,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen
}

function Brain({ size = 16, strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  )
}

function Incognito({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <g transform="translate(12, 16.482)">
        <path d="M3,0 C3,-1.105 3.895,-2 5,-2 C6.105,-2 7,-1.105 7,0 C7,1.105 6.105,2 5,2 C3.895,2 3,1.105 3,0z M-7,0 C-7,-1.105 -6.105,-2 -5,-2 C-3.895,-2 -3,-1.105 -3,0 C-3,1.105 -3.895,2 -5,2 C-6.105,2 -7,1.105 -7,0z M9,0 C9,-2.209 7.209,-4 5,-4 C3.42,-4 2.053,-3.084 1.403,-1.753 C0.458,-1.994 -0.459,-1.994 -1.404,-1.753 C-2.054,-3.083 -3.42,-4 -5,-4 C-7.209,-4 -9,-2.209 -9,0 C-9,2.209 -7.209,4 -5,4 C-2.861,4 -1.114,2.32 -1.006,0.208 C-0.32,0.016 0.319,0.017 1.005,0.208 C1.113,2.32 2.861,4 5,4 C7.209,4 9,2.209 9,0z" />
      </g>
      <g transform="translate(12, 7)">
        <path d="M6.422,-1.537 C6.056,-3.125 4.641,-4.25 3.011,-4.25 C3.011,-4.25 -3.011,-4.25 -3.011,-4.25 C-4.641,-4.25 -6.056,-3.125 -6.422,-1.537 C-6.422,-1.537 -7.296,2.25 -7.296,2.25 C-7.296,2.25 -10,2.25 -10,2.25 C-10,2.25 -10,4.25 -10,4.25 C-10,4.25 10,4.25 10,4.25 C10,4.25 10,2.25 10,2.25 C10,2.25 7.296,2.25 7.296,2.25 C7.296,2.25 6.422,-1.537 6.422,-1.537z" />
      </g>
    </svg>
  )
}

function NewTopic({ size = 16, strokeWidth = 1.75 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <g transform="translate(12, 12)">
        <path d="M-2,-8 C-3.864,-8 -4.796,-8 -5.531,-7.696 C-6.511,-7.29 -7.29,-6.511 -7.696,-5.531 C-8,-4.796 -8,-3.864 -8,-2 C-8,-2 -8,1.6 -8,1.6 C-8,3.84 -8,4.96 -7.564,5.816 C-7.181,6.569 -6.569,7.181 -5.816,7.564 C-4.96,8 -3.84,8 -1.6,8 C-1.6,8 2,8 2,8 C3.864,8 4.796,8 5.531,7.696 C6.511,7.29 7.29,6.511 7.696,5.531 C8,4.796 8,3.864 8,2" />
      </g>
      <g transform="translate(14.561, 9.439)">
        <path d="M4.939,-1.939 C4.939,-1.939 -2.121,5.121 -2.121,5.121 C-2.402,5.402 -2.784,5.561 -3.182,5.561 C-3.182,5.561 -5.561,5.561 -5.561,5.561 C-5.561,5.561 -5.561,3.182 -5.561,3.182 C-5.561,2.784 -5.402,2.402 -5.121,2.121 C-5.121,2.121 1.939,-4.939 1.939,-4.939 C2.767,-5.767 4.111,-5.767 4.939,-4.939 C5.767,-4.111 5.767,-2.767 4.939,-1.939z" />
      </g>
    </svg>
  )
}

export function Icon({ name, size = 16, filled = false }: { name: string; size?: number; filled?: boolean }) {
  const Component = icons[name] ?? Sparkles
  // 1.8 stroke on the 24px grid matches FlClash's rounded geometric Glyph proportions.
  return <Component size={size} strokeWidth={1.8} filled={filled} />
}
