import React from 'react'

type IconProps = {
  size?: number
  strokeWidth?: number
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

function CircleHelp({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.25a2.7 2.7 0 0 1 5 1.4c0 1.7-1.9 2.45-2.5 3.35" />
      <circle cx="12" cy="16.9" r="0.6" fill="currentColor" stroke="none" />
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

function FileText({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
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

function CopyIcon({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function FlaskConical({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M10 3h4" />
      <path d="M10 3v4.5l-5.8 9.5A2 2 0 0 0 5.9 20h12.2a2 2 0 0 0 1.7-3l-5.8-9.5V3" />
      <path d="M8 13h8" />
    </svg>
  )
}

function Languages({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M4 6h7" />
      <path d="M7.5 4v2a10 10 0 0 1-3 7" />
      <path d="M4.5 13c1.5-.2 3-.9 4.5-2.1" />
      <path d="M13 6h7" />
      <path d="M16.5 4v2a10 10 0 0 1-3 7" />
      <path d="M13.5 13c1.5-.2 3-.9 4.5-2.1" />
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

function ScanText({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M7 4H5a2 2 0 0 0-2 2v2" />
      <path d="M17 4h2a2 2 0 0 1 2 2v2" />
      <path d="M7 20H5a2 2 0 0 1-2-2v-2" />
      <path d="M17 20h2a2 2 0 0 0 2-2v-2" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </svg>
  )
}

function SearchIcon({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

function Sparkles({ size = 16, strokeWidth = 2 }: IconProps) {
  // Curved four-point star (lucide v2) — far more polished at small sizes
  // than the old three straight-edged diamonds.
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
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

function MousePointer({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="m4 4 7 16 2.2-7.2L20 10.5 4 4Z" />
    </svg>
  )
}

function Power({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 3v9" />
      <path d="M6.4 7.4a8 8 0 1 0 11.2 0" />
    </svg>
  )
}

function BookOpen({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2Z" />
      <path d="M12 6.5v12" />
    </svg>
  )
}

function Volume2({ size = 16, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M16 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5.5a9 9 0 0 1 0 13" />
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

const icons: Record<string, (props: IconProps) => React.JSX.Element> = {
  'circle-help': CircleHelp,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-up-right': ArrowUpRight,
  'book-open': BookOpen,
  power: Power,
  copy: CopyIcon,
  download: Download,
  'flask-conical': FlaskConical,
  languages: Languages,
  laptop: Laptop,
  moon: Moon,
  'mouse-pointer': MousePointer,
  pencil: Pencil,
  pin: Pin,
  'pin-off': PinOff,
  'scan-text': ScanText,
  search: SearchIcon,
  sparkles: Sparkles,
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
  'corner-down-right': CornerDownRight,
  clock: Clock,
  minus: Minus
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const Component = icons[name] ?? Sparkles
  // 1.75 stroke on the 24px grid: lighter, more refined at the 12–16px
  // sizes the app actually renders (2.0 looked chunky).
  return <Component size={size} strokeWidth={1.75} />
}
